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
      console.error(`localforge-codemode: lost the LocalForge output stream: ${e}`)
    } finally {
      // shortcut: no restart after the child exits; every later call fails until the host restarts this server.
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
    if (message?.id === undefined) {
      // Notifications need no reply.
      if (message?.method === "notifications/cancelled") controllers.get(message.params?.requestId)?.abort()
      continue
    }
    const id = message.id
    const controller = new AbortController()
    controllers.set(id, controller)
    const done = handle(message.method, message.params, controller.signal).then(
      (result) => write({ jsonrpc: "2.0", id, result }),
      (e) =>
        write({
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
