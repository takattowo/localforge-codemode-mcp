import { afterAll, describe, expect, spyOn, test } from "bun:test"
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
    // LocalForge's working folder; POSIX style, so a leading / counts as absolute in these tests.
    cwd: "/r",
    ...limits,
  })

const run = async (r: ReturnType<typeof createRunner>, code: string) => {
  const reply = await r.execute(code)
  return { ...reply, body: JSON.parse(reply.text) }
}

describe("execute", () => {
  test("single call returns the program's value and logs the call", async () => {
    const r = runner((name, args) => ok({ tool: name, path: args.path, size: 42 }))
    const { body, isError } = await run(r, `const s = await tools.localforge.filesystem({ action: "stat", path: "/r/a.txt" }); return s.size`)
    expect(isError).toBe(false)
    expect(body.ok).toBe(true)
    expect(body.value).toBe(42)
    expect(body.calls).toEqual([{ tool: "localforge.filesystem", status: "completed", input: '{"action":"stat","path":"/r/a.txt"}' }])
  })

  test("chained calls feed one result into the next", async () => {
    // LocalForge gives result paths under its own working folder relative to it; they must come back absolute.
    const files: Record<string, string> = { "/r/a.ts": "export const a = 1", "/r/b.ts": "export const b = 2" }
    const r = runner(
      (name, args) =>
        name === "search" ? ok({ results: [{ path: "a.ts" }, { path: "/r/b.ts" }] }) : ok({ content: files[args.path] }),
      { cwd: "/r" },
    )
    const { body } = await run(
      r,
      `const hits = await tools.localforge.search({ query: "export", path: "/r" })
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
      return args.path === "/r/secret" ? refused("path_denied", "Denied path: secret") : ok({ path: args.path })
    })
    const { body } = await run(
      r,
      `const rs = await Promise.allSettled(["/r/a", "/r/secret", "/r/b"].map((path) => tools.localforge.filesystem({ action: "stat", path })))
       return rs.map((x) => x.status === "fulfilled" ? x.value.path : x.reason.message)`,
    )
    expect(peak).toBe(3)
    expect(body.value[0]).toBe("/r/a")
    expect(body.value[1]).toContain("path_denied: Denied path: secret")
    expect(body.value[2]).toBe("/r/b")
    expect(body.calls.map((c: any) => c.status)).toEqual(["completed", "error", "completed"])
  })

  test("a caught tool error and a failed command still show as errors in the call log", async () => {
    const r = runner((name) =>
      name === "git" ? refused("invalid_arguments", "bad args") : ok({ success: false, exit_code: 1, stdout: "" }),
    )
    const { body, isError } = await run(
      r,
      `let caught = null
       try { await tools.localforge.git({ action: "nope", cwd: "/r" }) } catch (e) { caught = e.message }
       const res = await tools.localforge.execute({ command: ["tests"], cwd: "/r" })
       return { caught, exit: res.exit_code }`,
    )
    expect(isError).toBe(false)
    expect(body.value.caught).toContain("invalid_arguments: bad args")
    // An argument mistake points at where the argument notes are.
    expect(body.value.caught).toContain('search("localforge.git")')
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
    const { body } = await run(r, `for (let i = 0; i < 5; i++) await tools.localforge.git({ action: "status", cwd: "/r" }); return "done"`)
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
    // A non-array `required` must not crash or mark arguments by substring.
    const odd = runner(() => ok({}), {
      tools: [{ name: "git", inputSchema: { type: "object", properties: { action: {}, act: {} }, required: "action" } as object }],
    })
    expect(odd.description).toContain("\n- git({action?, act?})")
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
    const { body } = await run(r, `tools.localforge.git({ action: "status", cwd: "/r" }); return "left early"`)
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

  test("enum values behind anyOf, oneOf or a local $ref still show in the tool line", async () => {
    const nested = runner(() => ok({}), {
      tools: [
        {
          name: "git",
          inputSchema: {
            type: "object",
            properties: {
              mode: { anyOf: [{ enum: ["a", "b"] }, { type: "null" }] },
              kind: { $ref: "#/$defs/Kind" },
              old: { oneOf: [{ $ref: "#/definitions/Old" }] },
              loop: { $ref: "#/$defs/Loop" },
            },
            $defs: { Kind: { enum: ["x", "y"] }, Loop: { $ref: "#/$defs/Loop" } },
            definitions: { Old: { enum: [1, 2] } },
          } as object,
        },
      ],
    })
    expect(nested.description).toContain("\n- git({mode?: a|b, kind?: x|y, old?: 1|2, loop?})")

    // Repeats show once, null and objects as JSON, and only local #/$defs/X or #/definitions/X refs are followed.
    const odd = runner(() => ok({}), {
      tools: [
        {
          name: "git",
          inputSchema: {
            type: "object",
            properties: {
              mode: { anyOf: [{ enum: ["a", "b"] }, { enum: ["b", "c"] }] },
              val: { enum: [null, { x: 1 }, "s"] },
              far: { $ref: "other.json#/$defs/Kind" },
              deep: { $ref: "#/$defs/A/properties/Kind" },
            },
            $defs: { Kind: { enum: ["wrong"] }, A: { properties: { Kind: { enum: ["wrong"] } } } },
          } as object,
        },
      ],
    })
    expect(odd.description).toContain('\n- git({mode?: a|b|c, val?: null|{"x":1}|s, far?, deep?})')

    // Strings that read as JSON stay quoted, so they can't merge with the value they spell. A ref is looked up in
    // the table it names, with %-escapes, ~1 and ~0 decoded; inherited or broken names give nothing.
    const refs = runner(() => ok({}), {
      tools: [
        {
          name: "git",
          inputSchema: {
            type: "object",
            properties: {
              lit: { enum: ["null", null, "1", 1, "a"] },
              slash: { $ref: "#/$defs/a~1b" },
              tilde: { $ref: "#/$defs/t~0" },
              space: { $ref: "#/$defs/x%20y" },
              other: { $ref: "#/definitions/Kind" },
              ctor: { $ref: "#/$defs/constructor" },
              proto: { $ref: "#/$defs/__proto__" },
              bad: { $ref: "#/$defs/%E0%A4%A" },
            },
            $defs: { "a/b": { enum: ["s"] }, "t~": { enum: ["t"] }, "x y": { enum: ["y"] }, Kind: { enum: ["wrong"] } },
          } as object,
        },
      ],
    })
    expect(refs.description).toContain(
      '\n- git({lit?: "null"|null|"1"|1|a, slash?: s, tilde?: t, space?: y, other?, ctor?, proto?, bad?})',
    )

    // Blank strings, ones with | , { } or a quote, control characters, edge spaces and zero-width spaces are quoted
    // too, or they would vanish, break the line or read as another value. A %2F ref names a deeper pointer, not the
    // key "a/b", so it gives nothing; a #/definitions/X ref is found in definitions.
    const quoted = runner(() => ok({}), {
      tools: [
        {
          name: "git",
          inputSchema: {
            type: "object",
            properties: {
              blank: { enum: ["", "  ", "ok"] },
              sep: { enum: ["a|b", "a,b", "x{y", "x}y"] },
              ctl: { enum: ["a\nb", "t\tb", " a", "a ", '"ok', "\u200b"] },
              enc: { $ref: "#/$defs/a%2Fb" },
              defn: { $ref: "#/definitions/K" },
            },
            $defs: { "a/b": { enum: ["wrong"] } },
            definitions: { K: { enum: ["k"] } },
          } as object,
        },
      ],
    })
    expect(quoted.description).toContain(
      '\n- git({blank?: ""|"  "|ok, sep?: "a|b"|"a,b"|"x{y"|"x}y", ctl?: "a\\nb"|"t\\tb"|" a"|"a "|"\\"ok"|"\u200b", enc?, defn?: k})',
    )
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
    const warn = spyOn(console, "error").mockImplementation(() => {})
    try {
      runner(() => ok({}))
      expect(warn).not.toHaveBeenCalled()
      const d = runner(() => ok({}), { tools: huge }).description
      expect(d).toHaveLength(2_000)
      expect(d).toStartWith("Run JavaScript on the user's PC")
      expect(d).toEndWith("...")
      for (const rule of ["Limits: 5 s", "or return less", "waited on or stopped here", '\nArgument notes: return search("localforge.<tool>")'])
        expect(d).toContain(rule)
      expect(d).toContain("\n- filesystem({action: read|write|list|delete, ")
      expect(d).not.toContain("xxx")
      expect(warn.mock.calls.some((c) => String(c[0]).includes("execute description cut"))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  test("each run appends one line to the history file", async () => {
    const historyFile = join(spillDir, "history", "runs.jsonl")
    const r = runner(() => ok({ content: "x".repeat(1000) }), { historyFile, maxOutputBytes: 1_000 })
    await r.execute(`const f = await tools.localforge.filesystem({ action: "read", path: "/r/a" }); return f.content.length`)
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
      `for (let i = 0; i < 20; i++) await tools.localforge.search({ query: "\u65e5\u672c\u8a9e".repeat(40), path: "/r" })
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
    const { body } = await run(r, `await tools.localforge.git({ action: "status", cwd: "/r" }); return 1`)
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
      `for (let i = 0; i < 20; i++) await tools.localforge.search({ query: "\u65e5\u672c\u8a9e".repeat(40), path: "/r" })
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
    const reply = await r.execute(`await tools.localforge.git({ action: "status", cwd: "/r" }); return 1`, { signal: controller.signal })
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

  test("relative or missing paths and cwds are refused before they reach LocalForge", async () => {
    // LocalForge has one working folder per server, shared by every chat and task, so a relative path could
    // land in another session's repo.
    const seen: string[] = []
    const r = runner((name) => {
      seen.push(name)
      return ok({ done: true })
    })
    const { body } = await run(
      r,
      `const tries = [
         () => tools.localforge.filesystem({ action: "read", path: "src/a.ts" }),
         () => tools.localforge.filesystem({ action: "list" }),
         () => tools.localforge.filesystem({ action: "copy", path: "/r/a", destination: "b" }),
         () => tools.localforge.search({ query: "x" }),
         () => tools.localforge.search({ query: "x", path: "." }),
         () => tools.localforge.multi_search({ searches: [{ query: "x", path: "/r" }, { query: "y" }] }),
         () => tools.localforge.git({ action: "status" }),
         () => tools.localforge.git({ action: "status", cwd: "repo" }),
         () => tools.localforge.execute({ command: ["ls"] }),
         () => tools.localforge.process({ action: "start", command: ["ls"] }),
         () => tools.localforge.filesystem({ action: "read", file: "src/a.ts" }),
         () => tools.localforge.filesystem({ action: "copy", path: "/r/a", dest: "b" }),
         () => tools.localforge.git({ action: "status", cwd: null }),
       ]
       const out = []
       for (const t of tries) { try { await t(); out.push("allowed") } catch (e) { out.push(e.message) } }
       return out`,
    )
    expect(body.value).toHaveLength(13)
    for (const message of body.value) expect(message).toStartWith("relative_path: ")
    for (const message of body.value) expect(message).toContain("absolute")
    expect(body.value[0]).toContain("localforge.filesystem")
    expect(body.value[5]).toContain("searches[1] needs an absolute path")
    expect(seen).toEqual([])
    expect(body.calls.every((c: any) => c.status === "error")).toBe(true)

    const fine = await run(
      r,
      `await tools.localforge.filesystem({ action: "stat", path: "D:\\\\r\\\\a" })
       await tools.localforge.filesystem({ action: "stat", path: "D:/r/a" })
       await tools.localforge.filesystem({ action: "stat", path: "\\\\\\\\srv\\\\share\\\\a" })
       await tools.localforge.filesystem({ action: "copy", path: "/r/a", destination: "/r/b" })
       await tools.localforge.multi_search({ searches: [{ query: "x", path: "/r" }] })
       await tools.localforge.process({ action: "wait", process_id: "p1" })
       await tools.localforge.process({ action: "start", command: ["ls"], cwd: "/r" })
       await tools.localforge.filesystem({ action: "stat", file: "/r/a", destination: null })
       await tools.localforge.git({ action: "status", cwd: "/r", args: null })
       return "ok"`,
    )
    expect(fine.body.value).toBe("ok")
    expect(seen).toHaveLength(9)
  })

  test("on a Windows working folder, a path starting with one slash is drive-relative and refused", async () => {
    const seen: string[] = []
    const r = runner(
      (name) => {
        seen.push(name)
        return ok({})
      },
      { cwd: "D:\\work" },
    )
    const { body } = await run(
      r,
      `const out = []
       for (const path of ["/d/x", "\\\\x", "D:\\\\x", "d:/x", "\\\\\\\\srv\\\\share\\\\x", "//srv/share/x"]) {
         try { await tools.localforge.filesystem({ action: "stat", path }); out.push("allowed") } catch (e) { out.push(e.message.split(":")[0]) }
       }
       return out`,
    )
    expect(body.value).toEqual(["relative_path", "relative_path", "allowed", "allowed", "allowed", "allowed"])
    expect(seen).toHaveLength(4)
  })

  test("relative result paths from search and multi_search come back absolute", async () => {
    const r = runner(
      (name) =>
        name === "search"
          ? ok({ results: [{ path: "src\\a.ts" }, { path: "D:\\x\\b.ts" }] })
          : ok({ results: [{ label: "one", results: [{ path: "c.ts" }] }, { label: "bad", error: { code: "x" } }] }),
      { cwd: "D:\\base\\" },
    )
    const { body } = await run(
      r,
      `const s = await tools.localforge.search({ query: "q", path: "D:\\\\base" })
       const m = await tools.localforge.multi_search({ searches: [{ query: "q", path: "D:\\\\base" }] })
       return [...s.results.map((x) => x.path), ...m.results.flatMap((e) => (e.results ?? []).map((x) => x.path))]`,
    )
    expect(body.value).toEqual(["D:\\base\\src\\a.ts", "D:\\x\\b.ts", "D:\\base\\c.ts"])

    // A relative hit takes the working folder's separator.
    const posix = runner(() => ok({ results: [{ path: "src\\a.ts" }] }), { cwd: "/base/" })
    const p = await run(posix, `return (await tools.localforge.search({ query: "q", path: "/base" })).results[0].path`)
    expect(p.body.value).toBe("/base/src/a.ts")
  })

  test("without a known working folder, relative hits are left as they are", async () => {
    const r = runner(() => ok({ results: [{ path: "src\\a.ts" }] }), { cwd: undefined })
    const { body } = await run(r, `return (await tools.localforge.search({ query: "q", path: "D:\\\\r" })).results[0].path`)
    expect(body.value).toBe("src\\a.ts")
  })
})
