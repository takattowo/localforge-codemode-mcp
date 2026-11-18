import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRunner, type CallResult, type McpTool } from "../src/runner"

// Stands in for LocalForge's tools/list: names and loose input schemas are all the runner uses.
const TOOLS: McpTool[] = ["filesystem", "search", "multi_search", "git", "execute", "process", "batch", "todo", "workspace"].map(
  (name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", additionalProperties: true } }),
)

const ok = (value: unknown): CallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] })
const refused = (code: string, message: string): CallResult => ({
  content: [{ type: "text", text: JSON.stringify({ code, message }) }],
  isError: true,
})

const spillDir = mkdtempSync(join(tmpdir(), "codemode-test-"))
afterAll(() => rmSync(spillDir, { recursive: true, force: true }))

const runner = (call: (name: string, args: any) => CallResult | Promise<CallResult>, limits: Partial<Parameters<typeof createRunner>[0]> = {}) =>
  createRunner({
    tools: TOOLS,
    call: async (name, args) => call(name, args),
    allowShell: true,
    timeoutMs: 5_000,
    maxTimeoutMs: 5_000,
    maxToolCalls: 50,
    maxOutputBytes: 30_000,
    spillDir,
    ...limits,
  })

const run = async (r: ReturnType<typeof createRunner>, code: string) => {
  const reply = await r.execute(code)
  return { ...reply, body: JSON.parse(reply.text) }
}

describe("execute", () => {
  test("single call returns the program's value and logs the call", async () => {
    const r = runner((name, args) => ok({ tool: name, path: args.path, size: 42 }))
    const { body, isError } = await run(r, `const s = await tools.localforge.filesystem({ action: "stat", path: "a.txt" }); return s.size`)
    expect(isError).toBe(false)
    expect(body.ok).toBe(true)
    expect(body.value).toBe(42)
    expect(body.calls).toEqual([{ tool: "localforge.filesystem", status: "completed", input: '{"action":"stat","path":"a.txt"}' }])
  })

  test("chained calls feed one result into the next", async () => {
    const files: Record<string, string> = { "a.ts": "export const a = 1", "b.ts": "export const b = 2" }
    const r = runner((name, args) =>
      name === "search" ? ok({ results: [{ path: "a.ts" }, { path: "b.ts" }] }) : ok({ content: files[args.path] }),
    )
    const { body } = await run(
      r,
      `const hits = await tools.localforge.search({ query: "export" })
       const out = []
       for (const h of hits.results) out.push((await tools.localforge.filesystem({ action: "read", path: h.path })).content.length)
       return out`,
    )
    expect(body.value).toEqual([18, 18])
    expect(body.calls.map((c: any) => c.tool)).toEqual(["localforge.search", "localforge.filesystem", "localforge.filesystem"])
  })

  test("allSettled runs calls in parallel and keeps the refused one", async () => {
    let inFlight = 0
    let peak = 0
    const r = runner(async (_name, args) => {
      peak = Math.max(peak, ++inFlight)
      await Bun.sleep(30)
      inFlight--
      return args.path === "secret" ? refused("path_denied", "Denied path: secret") : ok({ path: args.path })
    })
    const { body } = await run(
      r,
      `const rs = await Promise.allSettled(["a", "secret", "b"].map((path) => tools.localforge.filesystem({ action: "stat", path })))
       return rs.map((x) => x.status === "fulfilled" ? x.value.path : x.reason.message)`,
    )
    expect(peak).toBe(3)
    expect(body.value[0]).toBe("a")
    expect(body.value[1]).toContain("path_denied: Denied path: secret")
    expect(body.value[2]).toBe("b")
    expect(body.calls.map((c: any) => c.status)).toEqual(["completed", "error", "completed"])
  })

  test("a caught tool error and a failed command still show as errors in the call log", async () => {
    const r = runner((name) =>
      name === "git" ? refused("invalid_arguments", "bad args") : ok({ success: false, exit_code: 1, stdout: "" }),
    )
    const { body, isError } = await run(
      r,
      `let caught = null
       try { await tools.localforge.git({ action: "nope" }) } catch (e) { caught = e.message }
       const res = await tools.localforge.execute({ command: ["tests"] })
       return { caught, exit: res.exit_code }`,
    )
    expect(isError).toBe(false)
    expect(body.value.caught).toContain("invalid_arguments: bad args")
    expect(body.value.exit).toBe(1)
    expect(body.calls.map((c: any) => [c.tool, c.status])).toEqual([
      ["localforge.git", "error"],
      ["localforge.execute", "error"],
    ])
  })

  test("timeout stops a runaway program", async () => {
    const r = runner(() => ok({}), { timeoutMs: 300 })
    const started = Date.now()
    const { body, isError } = await run(r, `while (true) {}`)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(isError).toBe(true)
    expect(body.ok).toBe(false)
    expect(body.error.kind).toBe("TimeoutExceeded")
  })

  test("maxToolCalls stops the program at the limit", async () => {
    const r = runner(() => ok({}), { maxToolCalls: 2 })
    const { body } = await run(r, `for (let i = 0; i < 5; i++) await tools.localforge.git({ action: "status" }); return "done"`)
    expect(body.ok).toBe(false)
    expect(body.error.kind).toBe("ToolCallLimitExceeded")
    expect(body.calls).toHaveLength(2)
  })

  test("a reply over the cap is saved to a file and returned as a path and preview", async () => {
    const r = runner(() => ok({}), { maxOutputBytes: 1_000 })
    const reply = await r.execute(`return "x".repeat(5000)`)
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(1_000)
    const body = JSON.parse(reply.text)
    expect(body.ok).toBe(true)
    expect(body.spilled.bytes).toBeGreaterThan(5_000)
    const full = JSON.parse(readFileSync(body.spilled.path, "utf8"))
    expect(full.value).toBe("x".repeat(5000))
  })

  test("batch, todo and workspace are hidden; execute and process only with allowShell", async () => {
    const shellOff = runner(() => ok({}), { allowShell: false })
    for (const name of ["batch", "todo", "workspace", "execute", "process"]) expect(shellOff.description).not.toContain(`\n- ${name}(`)
    for (const name of ["filesystem", "search", "multi_search", "git"]) expect(shellOff.description).toContain(`\n- ${name}(`)
    expect(runner(() => ok({})).description).toContain("\n- execute(")
    const { body } = await run(shellOff, `return await tools.localforge.batch({ calls: [] })`)
    expect(body.ok).toBe(false)
    expect(body.calls).toEqual([])
  })

  test("a program can ask for a longer timeout, capped at maxTimeoutMs", async () => {
    const r = runner(() => ok({}), { timeoutMs: 200, maxTimeoutMs: 1_000 })
    const timed = async (timeoutMs?: number) => {
      const started = Date.now()
      const reply = await r.execute(`while (true) {}`, { timeoutMs })
      return { ms: Date.now() - started, kind: JSON.parse(reply.text).error.kind }
    }
    const byDefault = await timed()
    const asked = await timed(600)
    const capped = await timed(60_000)
    expect([byDefault.kind, asked.kind, capped.kind]).toEqual(["TimeoutExceeded", "TimeoutExceeded", "TimeoutExceeded"])
    // Wide gaps between the three limits, so a busy machine doesn't make this flaky.
    expect(byDefault.ms).toBeLessThan(550)
    expect(asked.ms).toBeGreaterThanOrEqual(550)
    expect(asked.ms).toBeLessThan(950)
    expect(capped.ms).toBeGreaterThanOrEqual(950)
    expect(capped.ms).toBeLessThan(3_000)
    expect(r.description).toContain("timeout_seconds")
    // A default above the cap is advertised as the cap, which is what a run gets.
    expect(runner(() => ok({}), { timeoutMs: 900, maxTimeoutMs: 700 }).description).toContain("Limits: 0.7 s")
  })

  test("a call still running when the program ends is logged as interrupted", async () => {
    const r = runner(async () => {
      await Bun.sleep(300)
      return ok({})
    })
    const { body } = await run(r, `tools.localforge.git({ action: "status" }); return "left early"`)
    expect(body.value).toBe("left early")
    expect(body.calls.map((c: any) => c.status)).toEqual(["interrupted"])
  })

  test("the catalog leaves argument notes out unless fullCatalog; search() still returns them", async () => {
    const described: McpTool[] = [
      {
        name: "execute",
        description: "Run a command.",
        inputSchema: {
          type: "object",
          properties: {
            timeout: { type: "number", description: "Seconds to wait, not milliseconds" },
            description: { type: "string", description: "Note text" },
          },
        },
      },
    ]
    const lean = runner(() => ok({}), { tools: described })
    expect(lean.description).toContain("\n- execute({timeout?, description?})")
    expect(lean.description).not.toContain("Note text")
    expect(lean.description).not.toContain("Seconds to wait")
    expect(runner(() => ok({}), { tools: described, fullCatalog: true }).description).toContain("Seconds to wait")
    const { body } = await run(lean, `return JSON.stringify(search("localforge.execute"))`)
    expect(body.ok).toBe(true)
    expect(body.value).toContain("Seconds to wait")
  })

  test("the default description stays under Quick's 2,000-character limit, rules first", async () => {
    // Far bigger than LocalForge: 6 tools with 60 arguments each and an enum.
    const huge: McpTool[] = ["filesystem", "search", "multi_search", "git", "execute", "process"].map((name) => ({
      name,
      description: "x".repeat(3000),
      inputSchema: {
        type: "object",
        properties: Object.fromEntries([
          ["action", { type: "string", enum: ["read", "write", "list", "delete"] }],
          ...Array.from({ length: 60 }, (_, i) => [`argument_number_${i}`, { type: "string" }]),
        ]),
        required: ["action"],
      },
    }))
    const d = runner(() => ok({}), { tools: huge }).description
    expect(d.length).toBeLessThanOrEqual(2_000)
    expect(d).toStartWith("Run a JavaScript program")
    expect(d).toContain("Limits: 5 s")
    expect(d).toContain("\n- filesystem({action: read|write|list|delete, ")
    expect(d).not.toContain("xxx")
  })

  test("each run appends one line to the history file", async () => {
    const historyFile = join(spillDir, "history", "runs.jsonl")
    const r = runner(() => ok({ content: "x".repeat(1000) }), { historyFile, maxOutputBytes: 1_000 })
    await r.execute(`const f = await tools.localforge.filesystem({ action: "read", path: "a" }); return f.content.length`)
    await r.execute(`return "y".repeat(5000)`)
    await r.execute(`throw new Error("boom")`)
    const runs = readFileSync(historyFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(runs).toHaveLength(3)
    expect(runs[0]).toMatchObject({ ok: true, calls: 1, toolBytes: 1014, spilled: false })
    expect(runs[0].replyBytes).toBeLessThan(300)
    expect(runs[0].code).toContain("f.content.length")
    expect(typeof runs[0].ms).toBe("number")
    expect(runs[1]).toMatchObject({ ok: true, calls: 0, toolBytes: 0, spilled: true })
    expect(runs[2]).toMatchObject({ ok: false, error: "ExecutionFailure" })
  })

  test("a spilled reply stays under the cap with many calls and non-ASCII text", async () => {
    const r = runner(() => ok({}), { maxOutputBytes: 2_000 })
    const reply = await r.execute(
      `for (let i = 0; i < 20; i++) await tools.localforge.search({ query: "\u65e5\u672c\u8a9e".repeat(40) })
       return "\u65e5\u672c".repeat(3000)`,
    )
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(2_000)
    const body = JSON.parse(reply.text)
    expect(body.ok).toBe(true)
    expect(body.preview.length).toBeGreaterThan(0)
    expect(body.calls.length + (body.callsOmitted ?? 0)).toBe(20)
    expect(JSON.parse(readFileSync(body.spilled.path, "utf8")).value).toBe("\u65e5\u672c".repeat(3000))
  })

  test("a failing program that spills keeps its error at the top level", async () => {
    const r = runner(() => ok({}), { maxOutputBytes: 1_000 })
    const reply = await r.execute(`console.log("x".repeat(5000)); throw new Error("boom")`)
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(1_000)
    expect(reply.isError).toBe(true)
    const body = JSON.parse(reply.text)
    expect(body.ok).toBe(false)
    expect(body.error.kind).toBe("ExecutionFailure")
    expect(body.error.message).toContain("boom")
    expect(body.spilled.path).toBeString()
  })

  test("an internal failure still gives a tool result and a history line", async () => {
    const historyFile = join(spillDir, "internal", "runs.jsonl")
    const notADir = join(spillDir, "not-a-dir")
    writeFileSync(notADir, "")
    const r = runner(() => ok({}), { spillDir: notADir, maxOutputBytes: 1_000, historyFile })
    const reply = await r.execute(`return "x".repeat(5000)`)
    expect(reply.isError).toBe(true)
    expect(JSON.parse(reply.text).error.kind).toBe("InternalError")
    const [run] = readFileSync(historyFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(run).toMatchObject({ ok: false, error: "InternalError" })
  })

  test("a cyclic tool argument does not break the run", async () => {
    const r = runner(() => ok({}))
    const reply = await r.execute(
      `const a = { action: "status" }; a.self = a
       try { await tools.localforge.git(a); return "called" } catch (e) { return "caught" }`,
    )
    expect(typeof JSON.parse(reply.text).ok).toBe("boolean")
  })

  test("a call in flight at the timeout is logged as interrupted", async () => {
    const r = runner(async () => {
      await Bun.sleep(2_000)
      return ok({})
    }, { timeoutMs: 200 })
    const { body } = await run(r, `await tools.localforge.git({ action: "status" }); return 1`)
    expect(body.error.kind).toBe("TimeoutExceeded")
    expect(body.calls.map((c: any) => c.status)).toEqual(["interrupted"])
  })

  test("an aborted run stops early and is reported as cancelled", async () => {
    const historyFile = join(spillDir, "cancel", "runs.jsonl")
    const r = runner(() => ok({}), { historyFile })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const reply = await r.execute(`while (true) {}`, { signal: controller.signal })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(reply.isError).toBe(true)
    expect(JSON.parse(reply.text).error.kind).toBe("Cancelled")
    const [line] = readFileSync(historyFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(line).toMatchObject({ ok: false, error: "Cancelled" })
  })

  test("the cancelled or internal-error reply keeps to the cap too", async () => {
    const r = runner(() => ok({}), { maxOutputBytes: 2_000 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const reply = await r.execute(
      `for (let i = 0; i < 20; i++) await tools.localforge.search({ query: "\u65e5\u672c\u8a9e".repeat(40) })
       while (true) {}`,
      { signal: controller.signal },
    )
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(2_000)
    const body = JSON.parse(reply.text)
    expect(body.error.kind).toBe("Cancelled")
    expect(body.calls.length + (body.callsOmitted ?? 0)).toBe(20)
  })

  test("a call in flight when the run is cancelled is logged as interrupted", async () => {
    const r = runner(async () => {
      await Bun.sleep(2_000)
      return ok({})
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const reply = await r.execute(`await tools.localforge.git({ action: "status" }); return 1`, { signal: controller.signal })
    const body = JSON.parse(reply.text)
    expect(body.error.kind).toBe("Cancelled")
    expect(body.calls.map((c: any) => c.status)).toEqual(["interrupted"])
  })

  test("a spill preview never ends in half a surrogate pair", async () => {
    for (const prefix of ["", "x", "xx", "xxx"])
      for (const cap of [1_000, 1_001, 1_002, 1_003]) {
        const r = runner(() => ok({}), { maxOutputBytes: cap })
        const body = JSON.parse((await r.execute(`return ${JSON.stringify(prefix)} + "\ud83d\ude00".repeat(2000)`)).text)
        expect(body.spilled).toBeDefined()
        expect(/[\ud800-\udbff]$/.test(body.preview)).toBe(false)
      }
  })
})
