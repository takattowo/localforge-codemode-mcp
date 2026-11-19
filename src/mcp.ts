// Newline-delimited JSON-RPC 2.0 over stdio, the framing MCP's stdio transport uses.

type Json = any

export async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line) yield line
    }
  }
  // A last line without a newline still counts.
  const rest = (buffer + decoder.decode()).trim()
  if (rest) yield rest
}

// ASCII-only output, as LocalForge sends it, so no host decodes it in the wrong code page.
const encode = (message: Json) =>
  JSON.stringify(message).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n"

/** Starts an MCP server as a child process and talks to it as a client. */
export function startClient(command: string[], env: Record<string, string | undefined>) {
  // stderr is inherited so the child's logs reach the host's log, and the pipe never fills up.
  const child = Bun.spawn(command, { env, stdin: "pipe", stdout: "pipe", stderr: "inherit", windowsHide: true })
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  let nextId = 1
  let closed = false
  const write = (message: Json) => {
    child.stdin.write(encode(message))
    child.stdin.flush()
  }
  ;(async () => {
    try {
      for await (const line of lines(child.stdout)) {
        let message: Json
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        // Only replies settle a call: skip junk and the child's own requests and notifications (they have a method).
        if (typeof message !== "object" || message === null || "method" in message) continue
        const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined
        if (!waiter) continue
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message ?? "JSON-RPC error"))
        else waiter.resolve(message.result)
      }
    } catch (e) {
      console.error(`localforge-codemode-mcp: lost the LocalForge output stream: ${e}`)
    } finally {
      closed = true
      for (const waiter of pending.values()) waiter.reject(new Error("LocalForge exited"))
      pending.clear()
    }
  })()
  return {
    request: (method: string, params?: Json) =>
      new Promise<Json>((resolve, reject) => {
        if (closed) return reject(new Error("LocalForge is not running"))
        const id = nextId++
        pending.set(id, { resolve, reject })
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
      }),
    notify: (method: string) => write({ jsonrpc: "2.0", method }),
    close: () => child.stdin.end(),
    get closed() {
      return closed
    },
  }
}

/**
 * Starts an MCP server and initializes it; if it exits, the next request starts and initializes a fresh one.
 * onRestart gets each fresh one after the first, before the requests waiting on it run.
 */
export function connect(
  command: string[],
  env: Record<string, string | undefined>,
  clientInfo: { name: string; version: string },
  onRestart?: (client: ReturnType<typeof startClient>) => Promise<void>,
) {
  type Client = ReturnType<typeof startClient>
  let stopped = false
  let started = false
  // null: no start in progress or running; the next request starts one.
  let current: Promise<Client> | null = null
  const start = () => {
    const starting = (async () => {
      const client = startClient(command, env)
      await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo })
      client.notify("notifications/initialized")
      if (started) await onRestart?.(client)
      started = true
      return client
    })()
    current = starting
    // A start that fails fails every request waiting on it; the next request starts again.
    starting.catch(() => {
      if (current === starting) current = null
    })
    return starting
  }
  const notRunning = () => new Error("LocalForge is not running")
  const ready = async (): Promise<Client> => {
    if (stopped) throw notRunning()
    const was = current ?? start()
    const client = await was
    if (stopped) throw notRunning()
    if (!client.closed) return client
    // One restart for every request that finds it gone.
    if (current === was) {
      console.error("localforge-codemode-mcp: LocalForge is not running; starting it again")
      start()
    }
    return ready()
  }
  start()
  return {
    request: async (method: string, params?: Json) => (await ready()).request(method, params),
    // Stops restarts first, then ends the child once its start (if any) settles.
    close: () => {
      stopped = true
      current?.then((client) => client.close(), () => {})
    },
  }
}

/** Serves requests from stdin until it closes, then waits for the ones still running. */
export async function serve(handle: (method: string, params: Json, signal: AbortSignal) => Promise<Json>) {
  const write = (message: Json) => process.stdout.write(encode(message))
  const running = new Set<Promise<unknown>>()
  // Per request id, so notifications/cancelled can stop the request it names.
  const controllers = new Map<unknown, AbortController>()
  for await (const line of lines(Bun.stdin.stream())) {
    let message: Json
    try {
      message = JSON.parse(line)
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      continue
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } })
      continue
    }
    if (message.id === undefined) {
      // Notifications need no reply.
      if (message.method === "notifications/cancelled") controllers.get(message.params?.requestId)?.abort()
      continue
    }
    const id = message.id
    const controller = new AbortController()
    controllers.set(id, controller)
    // A cancelled request gets no reply (MCP: the receiver should not answer it).
    const reply = (message: Json) => controller.signal.aborted || write(message)
    const done = handle(message.method, message.params, controller.signal).then(
      (result) => reply({ jsonrpc: "2.0", id, result }),
      (e) =>
        reply({
          jsonrpc: "2.0",
          id,
          // JSON-RPC codes are integers; a Node error's code is a string such as EACCES.
          error: { code: Number.isInteger(e?.code) ? e.code : -32603, message: String(e?.message ?? e) },
        }),
    )
    running.add(done)
    done.finally(() => {
      running.delete(done)
      controllers.delete(id)
    })
  }
  await Promise.allSettled(running)
}
