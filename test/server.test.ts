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
      writeFileSync(
        testConfig,
        JSON.stringify({
          ...real,
          mcpConfig: resolve(dirname(configPath), real.mcpConfig),
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
          return { own: own.path, denied }`

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
        // Quick cuts tool descriptions at about 2,048 characters.
        expect(tool.description.length).toBeLessThanOrEqual(2_000)
        for (const name of ["filesystem", "search", "multi_search", "git", "execute", "process"])
          expect(tool.description).toContain(`\n- ${name}({`)
        expect(tool.description).not.toContain("\n- batch(")
        expect(tool.description).toContain("interrupted calls may still finish")
        expect(tool.description).toContain("waited on or stopped here")
        expect(tool.description).toContain("or return less")
        expect(tool.description.endsWith("...")).toBe(false)
        console.log(`execute description: ${tool.description.length} chars, ~${Math.round(tool.description.length / 4)} tokens`)

        const call = replies.get(3).result
        expect(call.isError).toBeUndefined()
        const body = JSON.parse(call.content[0].text)
        expect(body.ok).toBe(true)
        expect(body.value.own).toBe(own)
        expect(body.value.denied).toContain("path_denied")
        expect(body.calls.map((c: any) => c.status)).toEqual(["completed", "error"])

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
