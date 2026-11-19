import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
    const { body, isError } = await run(r, `const s = await tools.localforge.filesystem({ action: "stat", path: "/r/a.txt" }); return s.size`)
    expect(isError).toBe(false)
    expect(body.ok).toBe(true)
    expect(body.value).toBe(42)
    // A completed call is only counted: the program already has its result.
    expect(body.completed).toEqual({ "localforge.filesystem": 1 })
    expect(body.calls).toEqual([])
    expect(Object.keys(body).slice(-2)).toEqual(["completed", "calls"])
  })

  test("chained calls feed one result into the next", async () => {
    const files: Record<string, string> = { "/r/a.ts": "export const a = 1", "/r/b.ts": "export const b = 2" }
    const r = runner((name, args) =>
      name === "search" ? ok({ results: [{ path: "/r/a.ts" }, { path: "/r/b.ts" }] }) : ok({ content: files[args.path] }),
    )
    const { body } = await run(
      r,
      `const hits = await tools.localforge.search({ query: "export", path: "/r" })
       const out = []
       for (const h of hits.results) out.push((await tools.localforge.filesystem({ action: "read", path: h.path })).content.length)
       return out`,
    )
    expect(body.value).toEqual([18, 18])
    expect(body.completed).toEqual({ "localforge.search": 1, "localforge.filesystem": 2 })
    expect(body.calls).toEqual([])
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
    expect(body.completed).toEqual({ "localforge.filesystem": 2 })
    expect(body.calls).toEqual([{ tool: "localforge.filesystem", status: "error", input: '{"action":"stat","path":"/r/secret"}' }])
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
    expect(body).not.toHaveProperty("completed")
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
    // A failed run has no value, so every call keeps its row: the model must see which side effects happened.
    expect(body).not.toHaveProperty("completed")
    expect(body.calls.map((c: any) => c.status)).toEqual(["completed", "completed"])
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

  test("only the newest 100 spilled replies are kept, and other files stay", async () => {
    const dir = join(spillDir, "prune")
    mkdirSync(dir)
    const name = (i: number) => `result-${1_000_000_000_000 + i}-0000000${i % 10}.json`
    for (let i = 0; i < 105; i++) writeFileSync(join(dir, name(i)), "{}")
    writeFileSync(join(dir, "notes.json"), "{}")
    const reply = await runner(() => ok({}), { spillDir: dir, maxOutputBytes: 1_000 }).execute(`return "x".repeat(5000)`)
    const left = readdirSync(dir)
    expect(left.filter((n) => n.startsWith("result-"))).toHaveLength(100)
    expect(existsSync(JSON.parse(reply.text).spilled.path)).toBe(true)
    expect(left).not.toContain(name(5))
    expect(left).toContain(name(6))
    expect(left).toContain("notes.json")
  })

  test("a call LocalForge cut for size hands the program the full result from result_path", async () => {
    const full = { results: [{ path: "/r/a.log", matches: Array.from({ length: 100 }, (_, i) => ({ line: i + 1, text: `l${i}` })) }] }
    const saved = join(spillDir, "lf-search-result-x.json")
    writeFileSync(saved, JSON.stringify(full, null, 1))
    // LocalForge's cut reply: a few matches, then a marker string in the list.
    const cut = (result_path: string | null) =>
      ok({
        result_too_large: true,
        bytes: 900_000,
        result_path,
        hint: "Read result_path ...",
        results: [{ path: "/r/a.log", matches: [{ line: 1, text: "l0" }, "...[cut: showing 1 of 100 items; full result in result_path]"] }],
      })
    const code = `const r = await tools.localforge.search({ query: "l", path: "/r" }); return r.results[0].matches.map((m) => m.text).join(",")`
    const { body } = await run(runner(() => cut(saved)), code)
    expect(body.value).toBe(full.results[0]!.matches.map((m) => m.text).join(","))
    // No full copy: the call fails instead of handing over cut data.
    const failed = await run(runner(() => cut(null)), code)
    expect(failed.body.ok).toBe(false)
    expect(failed.body.error.message).toContain("max_result_bytes")
    expect(failed.body.error.message).toContain("no absolute result_path")
    // A relative path is not trusted either: it would be read from this server's own folder.
    const relative = await run(runner(() => cut("lf-search-result-x.json")), code)
    expect(relative.body.error.message).toContain("no absolute result_path")
    // A path that is gone, and a file that is not JSON, each say which one it was.
    const gone = await run(runner(() => cut(join(spillDir, "pruned.json"))), code)
    expect(gone.body.error.message).toContain("could not be read")
    const garbled = join(spillDir, "lf-garbled.json")
    writeFileSync(garbled, "{not json")
    const bad = await run(runner(() => cut(garbled)), code)
    expect(bad.body.error.message).toContain("is not valid JSON")
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
      for (const rule of ["Limits: 5 s", "or return less", "only reachable here", '; argument notes: return search("localforge.<tool>")'])
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
    // Every other command fails, so half the calls keep a row and the rest are only counted.
    let n = 0
    const r = runner(() => ok(n++ % 2 ? { success: false } : {}), { maxOutputBytes: 2_000 })
    const reply = await r.execute(
      `for (let i = 0; i < 20; i++) await tools.localforge.search({ query: "\u65e5\u672c\u8a9e".repeat(40), path: "/r" })
       return "\u65e5\u672c".repeat(3000)`,
    )
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(2_000)
    const body = JSON.parse(reply.text)
    expect(body.ok).toBe(true)
    expect(body.preview.length).toBeGreaterThan(0)
    expect(body.completed).toEqual({ "localforge.search": 10 })
    expect(body.calls.length + (body.callsOmitted ?? 0)).toBe(10)
    expect(body.calls.every((c: any) => c.status === "error")).toBe(true)
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
    expect(body).not.toHaveProperty("completed")
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

  test("paths go to LocalForge as written, and its relative_path refusal reaches the program", async () => {
    // LocalForge (require_absolute_paths, on by default) refuses relative locations and returns absolute hits itself.
    const seen: unknown[] = []
    const r = runner((name, args) => {
      seen.push(args)
      return name === "search"
        ? ok({ results: [{ path: "src\\a.ts" }] })
        : refused("relative_path", "filesystem read needs an absolute path, or an absolute cwd (got 'a')")
    })
    const { body } = await run(
      r,
      `const hits = await tools.localforge.search({ query: "q", path: "src" })
       let refusal = null
       try { await tools.localforge.filesystem({ action: "read", path: "a" }) } catch (e) { refusal = e.message }
       return { hits: hits.results.map((h) => h.path), refusal }`,
    )
    expect(seen).toEqual([{ query: "q", path: "src" }, { action: "read", path: "a" }])
    expect(body.value.hits).toEqual(["src\\a.ts"])
    expect(body.value.refusal).toBe("relative_path: filesystem read needs an absolute path, or an absolute cwd (got 'a')")
  })
})
