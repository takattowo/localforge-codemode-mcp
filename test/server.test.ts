import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { lines } from "../src/mcp"

const root = join(import.meta.dir, "..")
const configPath = resolve(process.env.LOCALFORGE_CODEMODE_CONFIG ?? join(root, "codemode.json"))

// Starts the server with a config file holding `content` and returns how it ended.
const startWith = async (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "localforge-codemode-mcp-test-"))
  try {
    const path = join(dir, "codemode.json")
    writeFileSync(path, content)
    const server = Bun.spawn([process.execPath, join(root, "src", "server.ts")], {
      env: { ...process.env, LOCALFORGE_CODEMODE_CONFIG: path },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    server.stdin.end()
    return { path, code: await server.exited, stderr: await new Response(server.stderr).text() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a config without mcpConfig fails with a clear message", async () => {
  const { path, code, stderr } = await startWith("{}")
  expect(code).not.toBe(0)
  expect(stderr).toContain(`mcpConfig is required in ${path}`)
}, 20_000)

test("a config that is not a JSON object fails with a clear message", async () => {
  for (const content of ["null", "[]", "7"]) {
    const { path, code, stderr } = await startWith(content)
    expect(code).not.toBe(0)
    expect(stderr).toContain(`${path} must hold a JSON object`)
  }
}, 30_000)

// A fake LocalForge whose second start has one more tool, or with mode "fail-relist" fails tools/list from its second
// start on. A filesystem call with action "die" makes it exit.
const GROWING = `
import { appendFileSync, readFileSync } from "node:fs"
const [log, mode] = process.argv.slice(2)
appendFileSync(log, "start\\n")
const starts = readFileSync(log, "utf8").trim().split("\\n").length
const tool = (name) => ({ name, inputSchema: { type: "object", properties: { action: { type: "string" } } } })
const decoder = new TextDecoder()
let buffer = ""
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
const fail = (id) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "tools/list broke" } }) + "\\n")
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let end
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === "initialize") send(m.id, { protocolVersion: "2025-06-18" })
    else if (m.method === "tools/list" && starts > 1 && mode === "fail-relist") fail(m.id)
    else if (m.method === "tools/list") send(m.id, { tools: starts > 1 ? [tool("filesystem"), tool("search")] : [tool("filesystem")] })
    else if (m.method === "tools/call") {
      if (m.params.arguments?.action === "die") process.exit(1)
      send(m.id, { content: [{ type: "text", text: JSON.stringify({ tool: m.params.name, start: starts }) }] })
    }
  }
}
`

// Starts the server on GROWING (mode goes to the fake) and initializes it.
const startGrowing = async (mode = "") => {
  const dir = mkdtempSync(join(tmpdir(), "localforge-codemode-mcp-test-"))
  const script = join(dir, "growing.ts")
  writeFileSync(script, GROWING)
  const mcpConfig = join(dir, "mcp_config.json")
  const entry = { command: process.execPath, args: [script, join(dir, "starts.log"), mode] }
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { "localforge-mcp": entry } }))
  const config = join(dir, "codemode.json")
  writeFileSync(config, JSON.stringify({ mcpConfig, historyFile: null, spillDir: join(dir, "spill") }))
  const server = Bun.spawn([process.execPath, join(root, "src", "server.ts")], {
    env: { ...process.env, LOCALFORGE_CODEMODE_CONFIG: config },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  const replies = lines(server.stdout)[Symbol.asyncIterator]()
  let id = 0
  const ask = async (method: string, params?: object) => {
    const sent = ++id
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: sent, method, params }) + "\n")
    for (;;) {
      const { value, done } = await replies.next()
      if (done) throw new Error("server exited")
      const m = JSON.parse(value)
      if (m.id === sent) return m.result
    }
  }
  const growing = {
    run: async (code: string) => JSON.parse((await ask("tools/call", { name: "execute", arguments: { code } })).content[0].text),
    description: async () => (await ask("tools/list")).tools[0].description,
    // LocalForge exits on this call; the next call starts it again.
    die: () => growing.run(`try { await tools.localforge.filesystem({ action: "die" }) } catch (e) {} return 0`),
    end: () => (server.stdin.end(), server.exited),
    cleanup: () => (server.kill(), rmSync(dir, { recursive: true, force: true })),
  }
  try {
    await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })
  } catch (e) {
    growing.cleanup()
    throw e
  }
  return growing
}

test("a restarted LocalForge's new tools reach programs and the tool list", async () => {
  const g = await startGrowing()
  try {
    expect(await g.description()).not.toContain("\n- search(")
    await g.die()
    // This call starts LocalForge again; the tool list is read before it runs.
    expect((await g.run(`return await tools.localforge.filesystem({})`)).value).toEqual({ tool: "filesystem", start: 2 })
    expect(await g.description()).toContain("\n- search({action?})")
    expect((await g.run(`return await tools.localforge.search({})`)).value).toEqual({ tool: "search", start: 2 })
    expect(await g.end()).toBe(0)
  } finally {
    g.cleanup()
  }
}, 30_000)

test("when the restarted LocalForge's tool list fails, the old tools stay and calls still run", async () => {
  const g = await startGrowing("fail-relist")
  try {
    const before = await g.description()
    await g.die()
    expect((await g.run(`return await tools.localforge.filesystem({})`)).value).toEqual({ tool: "filesystem", start: 2 })
    expect(await g.description()).toBe(before)
    expect(await g.end()).toBe(0)
  } finally {
    g.cleanup()
  }
}, 30_000)

// Needs a real LocalForge, so it runs only where codemode.json (gitignored) points at one with a denied path.
const denied = (() => {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    const mcpConfig = resolve(dirname(configPath), config.mcpConfig)
    const entry = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers[config.server ?? "localforge-mcp"]
    const path = JSON.parse(readFileSync(entry.env.LOCALFORGE_CONFIG, "utf8")).denied_paths[0]
    return typeof path === "string" ? path : undefined
  } catch {
    return undefined
  }
})()

describe.skipIf(denied === undefined)("server over stdio with the real LocalForge", () => {
  test(
    "lists execute, runs a real call, LocalForge refuses a denied path, and a cancelled call stops",
    async () => {
      // Run on a copy of the real config whose history and spills go to a temp folder, so tests never add lines
      // to the real run history.
      const real = JSON.parse(readFileSync(configPath, "utf8"))
      const realHistory =
        typeof real.historyFile === "string" ? resolve(dirname(configPath), real.historyFile) : join(root, ".history", "runs.jsonl")
      const sizeOf = (p: string) => (existsSync(p) ? statSync(p).size : 0)
      const before = sizeOf(realHistory)
      const dir = mkdtempSync(join(tmpdir(), "localforge-codemode-mcp-test-"))
      const testConfig = join(dir, "codemode.json")
      const testHistory = join(dir, "runs.jsonl")
      // LocalForge restores its working folder from its state file. Pin it to this repo on a copy of its config, so
      // search hits are under its working folder and LocalForge's own absolute-path rule is always exercised.
      const name = real.server ?? "localforge-mcp"
      const lf = JSON.parse(readFileSync(resolve(dirname(configPath), real.mcpConfig), "utf8")).mcpServers[name]
      const stateFile = join(dir, "state.json")
      writeFileSync(stateFile, JSON.stringify({ version: 1, cwd: root }))
      const lfConfig = join(dir, "localforge.json")
      writeFileSync(lfConfig, JSON.stringify({ ...JSON.parse(readFileSync(lf.env.LOCALFORGE_CONFIG, "utf8")), state_file: stateFile }))
      const testMcp = join(dir, "mcp_config.json")
      writeFileSync(testMcp, JSON.stringify({ mcpServers: { [name]: { ...lf, env: { ...lf.env, LOCALFORGE_CONFIG: lfConfig } } } }))
      writeFileSync(
        testConfig,
        JSON.stringify({
          ...real,
          mcpConfig: testMcp,
          historyFile: testHistory,
          spillDir: join(dir, "spill"),
        }),
      )
      try {
        const own = join(root, "package.json")
        const code = `
          const own = await tools.localforge.filesystem({ action: "stat", path: ${JSON.stringify(own)} })
          let denied = "allowed"
          try { await tools.localforge.filesystem({ action: "stat", path: ${JSON.stringify(denied)} }) } catch (e) { denied = e.message }
          let relative = "allowed"
          try { await tools.localforge.filesystem({ action: "stat", path: "package.json" }) } catch (e) { relative = e.message }
          const hits = await tools.localforge.search({ query: "createRunner", path: ${JSON.stringify(join(root, "src"))} })
          return { own: own.path, denied, relative, hits: hits.results.map((h) => h.path) }`

        const server = Bun.spawn([process.execPath, join(root, "src", "server.ts")], {
          env: { ...process.env, LOCALFORGE_CODEMODE_CONFIG: testConfig },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
        })
        const send = (m: object) => server.stdin.write(JSON.stringify(m) + "\n")
        const started = Date.now()
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })
        send({ jsonrpc: "2.0", method: "notifications/initialized" })
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "execute", arguments: { code } } })
        // Without the cancel this would run for the default 60 s; a cancelled request gets no reply.
        send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "execute", arguments: { code: "while (true) {}" } } })
        send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } })
        server.stdin.end()

        const replies = new Map<number, any>()
        for await (const line of lines(server.stdout)) {
          const m = JSON.parse(line)
          replies.set(m.id, m)
        }
        expect(await server.exited).toBe(0)
        expect(Date.now() - started).toBeLessThan(30_000)

        const [tool] = replies.get(2).result.tools
        expect(tool.name).toBe("execute")
        // Quick cuts tool descriptions at about 2,048 characters; 100 spare leaves LocalForge room to grow.
        expect(tool.description.length).toBeLessThanOrEqual(1_900)
        for (const name of ["filesystem", "search", "multi_search", "git", "execute", "process"])
          expect(tool.description).toContain(`\n- ${name}({`)
        expect(tool.description).not.toContain("\n- batch(")
        expect(tool.description).toContain("if ok, completed calls only as completed {tool: n}")
        expect(tool.description).toContain("only reachable here")
        expect(tool.description).toContain("or return less")
        expect(tool.description.endsWith("...")).toBe(false)
        console.log(`execute description: ${tool.description.length} chars, ~${Math.round(tool.description.length / 4)} tokens`)

        const call = replies.get(3).result
        expect(call.isError).toBeUndefined()
        const body = JSON.parse(call.content[0].text)
        expect(body.ok).toBe(true)
        expect(body.value.own).toBe(own)
        expect(body.value.denied).toContain("path_denied")
        expect(body.completed).toEqual({ "localforge.filesystem": 1, "localforge.search": 1 })
        expect(body.calls.map((c: any) => c.status)).toEqual(["error", "error"])
        // LocalForge itself refuses a relative path (its message quotes the path in single quotes).
        expect(body.value.relative).toStartWith("relative_path: ")
        expect(body.value.relative).toContain("got 'package.json'")
        // Hits come back absolute whatever LocalForge's working folder is.
        expect(body.value.hits).toContain(join(root, "src", "runner.ts"))
        for (const hit of body.value.hits) expect(hit).toMatch(/^[A-Za-z]:[\\/]|^[\\/]/)

        expect(replies.has(4)).toBe(false)

        // Both runs went to the test's own history; the real one is untouched.
        expect(readFileSync(testHistory, "utf8").trim().split("\n")).toHaveLength(2)
        expect(sizeOf(realHistory)).toBe(before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
