import { CodeMode, Extension, Tool, toolError } from "@opencode/codemode"
import { Effect } from "effect"
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

export type McpTool = { name: string; description?: string; inputSchema?: object }
export type CallResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean }
export type Options = {
  tools: McpTool[]
  call: (name: string, args: unknown) => Promise<CallResult>
  allowShell: boolean
  /** Default per program; a program may ask for more, up to maxTimeoutMs. */
  timeoutMs: number
  maxTimeoutMs: number
  maxToolCalls: number
  /** Reply cap; a bigger reply is saved under spillDir and the model gets its path. */
  maxOutputBytes: number
  spillDir: string
  /** Show each argument's notes in the description too (about 2.5x longer for LocalForge). */
  fullCatalog?: boolean
  /** One JSON line per run (code, outcome, bytes in and out), for measuring; unset writes none. */
  historyFile?: string
  /** Where keep() saves values, per session; one per runner when unset. */
  store?: Store
}
type Row = { tool: string; status: "running" | "completed" | "error" | "interrupted"; input: string }

// batch is what a script already does with Promise.allSettled/await, and would hide calls from maxToolCalls and the
// log; todo and workspace (cwd) are session state better kept on the direct LocalForge connection.
const HIDDEN = new Set(["batch", "todo", "workspace"])
const SHELL = new Set(["execute", "process"])
// codemode truncates (not spills) past its own maxOutputBytes, so give it a high ceiling and cap the reply ourselves.
// shortcut: a result up to this size is held in memory before spilling; raise it if scripts need to return more.
const VALUE_CEILING = 5_000_000
const INPUT_CHARS = 160
const DESCRIPTION_CHARS = 500
// Quick cuts a tool description at about 2,048 characters, so the default description stays under this.
const QUICK_LIMIT = 2_000
// Spilled replies kept, like LocalForge keeps its newest 100 saved results.
const SPILL_KEEP = 100
const SPILLED = /^result-\d+-[0-9a-f]{8}\.json$/
// What keep() may hold, as JSON bytes, across every session.
const KEEP_BYTES = 50_000_000
const IDENT = /^[A-Za-z_$][\w$]*$/
// Names a kept value can't take: the program's own globals, require (a program built-in not on Bun's globalThis),
// await (strict mode allows `let await`, but a program can never read it) and undefined.
const TAKEN = new Set(["tools", "search", "keep", "forget", "require", "await", "undefined"])
// The server's globals a program also has (JSON, Map, ...), probed once in a bare runtime; self, process, fetch and
// the like stay free. If the probe fails, every server global counts as taken.
const PROGRAM_GLOBALS = (() => {
  const names = Object.getOwnPropertyNames(globalThis).filter((n) => IDENT.test(n))
  const r = Effect.runSync(CodeMode.make({ tools: {} }).execute(`return [${names.map((n) => `typeof ${n}`).join(",")}]`, {}))
  return new Set(r.ok ? names.filter((_, i) => (r.value as string[])[i] !== "undefined") : names)
})()

const textOf = (r: CallResult) => (r.content ?? []).map((c) => c.text ?? "").join("")
const parse = (text: string): any => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + "..." : s)
// Program data can be cyclic or otherwise unserializable; a hook must never throw because of it.
const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v) ?? ""
  } catch {
    return "[unserializable]"
  }
}
const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v))
// keep() replacer: JSON.stringify writes a Set or Map as {}; keep their contents as an array and an object.
const asJson = (_: string, v: unknown) => (v instanceof Set ? [...v] : v instanceof Map ? Object.fromEntries(v) : v)
// Error messages in a capped reply get at most an eighth of the cap.
const clipError = (e: { kind: string; message: string }, cap: number) => ({
  kind: e.kind,
  message: clip(e.message, Math.floor(cap / 8)),
})
const failed = (v: any) => typeof v === "object" && v !== null && v.success === false
// LocalForge cuts a result over its max_result_bytes to fit the host's relay; a program filters results itself, so it
// gets the full copy LocalForge saved, or an error, never the cut one.
const whole = async (cut: any) => {
  const over = "result over LocalForge's max_result_bytes"
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const path = cut.result_path
  // LocalForge always names an absolute file; anything else would be read from this server's own folder.
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error(`${over} and no absolute result_path to read the full copy from; narrow the call`)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (e) {
    throw new Error(`${over} and its full copy could not be read (${why(e)}); narrow the call`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${over} and its full copy at ${path} is not valid JSON (${why(e)}); narrow the call`)
  }
}

// A completed call only as a count per tool: its row costs ~150-200 bytes and the program already has its result.
// Only for a run that succeeded: a failed run has no value, so its rows show which side effects happened.
const logOf = (all: Row[], ok: boolean) => {
  if (!ok) return { counts: {}, rows: all }
  const completed: Record<string, number> = {}
  for (const r of all) if (r.status === "completed") completed[r.tool] = (completed[r.tool] ?? 0) + 1
  return { counts: Object.keys(completed).length ? { completed } : {}, rows: all.filter((r) => r.status !== "completed") }
}
const callsPart = (all: Row[], kept: number) => ({
  calls: all.slice(0, kept),
  ...(kept < all.length ? { callsOmitted: all.length - kept } : {}),
})
// The most call rows, from the start, for which make() still fits the cap; callsOmitted counts the rest.
const keepCalls = (all: Row[], cap: number, make: (part: object) => object) => {
  let kept = all.length
  while (kept > 0 && bytesOf(make(callsPart(all, kept))) > cap) kept--
  return callsPart(all, kept)
}
// Enum values of an argument, also behind anyOf/oneOf or a local $ref (pydantic Optional[Literal], Enum).
// Only #/$defs/X or #/definitions/X, looked up in the table it names: other files or deeper pointers could match a
// local name by accident.
const LOCAL_REF = /^#\/(\$defs|definitions)\/([^/]+)$/
type Defs = { $defs?: unknown; definitions?: unknown }
// A JSON-pointer segment from a URI fragment: %-escapes first, then ~1 (/) and ~0 (~), as RFC 6901 says.
// An escaped slash (%2F) splits the pointer into more segments, so it can't name a single key here.
const segment = (raw: string) => {
  if (/%2f/i.test(raw)) return undefined
  try {
    return decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~")
  } catch {
    return undefined
  }
}
const enumOf = (v: any, defs: Defs, depth = 0): unknown[] => {
  if (!v || typeof v !== "object" || depth > 4) return []
  if (Array.isArray(v.enum)) return v.enum
  if (typeof v.$ref === "string") {
    const m = LOCAL_REF.exec(v.$ref)
    const table = m ? defs[m[1] as keyof Defs] : undefined
    const name = m ? segment(m[2]!) : undefined
    const found = name !== undefined && typeof table === "object" && table !== null && Object.hasOwn(table, name)
    return found ? enumOf((table as Record<string, unknown>)[name], defs, depth + 1) : []
  }
  const members = [...(Array.isArray(v.anyOf) ? v.anyOf : []), ...(Array.isArray(v.oneOf) ? v.oneOf : [])]
  return members.flatMap((m) => enumOf(m, defs, depth + 1))
}
const readsAsJson = (s: string) => {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}
// A value as the model would type it: strings bare unless they read as JSON ("null", "1"), are blank, have edge
// spaces, or hold a character the tool line uses (| , { } "), a control character or a zero-width space, so none
// can vanish, break the line, or read as another value; anything else (null, numbers, objects) as JSON.
const bare = (s: string) =>
  s !== "" && s === s.trim() && !/[\x00-\x1f\x7f|,{}"\u200b-\u200d\ufeff]/.test(s) && !readsAsJson(s)
const shown = (x: unknown) => (typeof x === "string" && bare(x) ? x : safeJson(x))
// One short line per tool: argument names (? when optional) and enum values, no notes.
const compact = (t: McpTool) => {
  const s = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: unknown } & Defs
  const required = Array.isArray(s.required) ? s.required : []
  const args = Object.entries(s.properties ?? {}).map(([k, v]) => {
    const values = [...new Set(enumOf(v, s).map(shown))]
    return `${k}${required.includes(k) ? "" : "?"}${values.length ? `: ${values.join("|")}` : ""}`
  })
  return `- ${t.name}({${args.join(", ")}})`
}

export type Store = ReturnType<typeof createStore>
// Values kept by keep(), per session, as JSON: copies, sized by their bytes. Memory only. Over maxBytes the least
// recently set values go first, whatever their session.
export function createStore(maxBytes = KEEP_BYTES) {
  const sessions = new Map<string, Map<string, { json: string; at: number }>>()
  let total = 0
  let clock = 0
  const drop = (session: string, name: string) => {
    const kept = sessions.get(session)
    const value = kept?.get(name)
    if (!kept || !value) return
    total -= Buffer.byteLength(value.json)
    kept.delete(name)
    if (!kept.size) sessions.delete(session)
  }
  return {
    maxBytes,
    names: (session: string) => [...(sessions.get(session)?.keys() ?? [])],
    // shortcut: parses the whole session's JSON on every run start; parse per name on first read if big sessions get slow.
    values: (session: string) =>
      Object.fromEntries([...(sessions.get(session) ?? [])].map(([name, v]) => [name, JSON.parse(v.json)])),
    keep(session: string, entries: Record<string, string>) {
      for (const [name, json] of Object.entries(entries)) {
        drop(session, name)
        if (!sessions.has(session)) sessions.set(session, new Map())
        sessions.get(session)!.set(name, { json, at: ++clock })
        total += Buffer.byteLength(json)
      }
      while (total > maxBytes) {
        let oldest: { session: string; name: string; at: number } | undefined
        for (const [session, kept] of sessions)
          for (const [name, { at }] of kept) if (!oldest || at < oldest.at) oldest = { session, name, at }
        drop(oldest!.session, oldest!.name)
      }
    },
    forget(session: string, name?: string) {
      for (const n of name === undefined ? this.names(session) : [name]) drop(session, n)
    },
  }
}

// A kept value becomes a variable, so its name must be one that isn't already taken.
const keepable = (name: string) => {
  if (!IDENT.test(name) || TAKEN.has(name) || PROGRAM_GLOBALS.has(name)) return false
  try {
    // Reserved words (if, let, yield, ...) pass the pattern; strict-mode parsing refuses them.
    new Function(`"use strict"; let ${name}`)
    return true
  } catch {
    return false
  }
}

export function createRunner(o: Options) {
  const store = o.store ?? createStore()
  const exposed = o.tools.filter((t) => !HIDDEN.has(t.name) && (o.allowShell || !SHELL.has(t.name)))
  // Programs run against the full schemas, so search() inside a program shows every argument's notes.
  const tree = {
    localforge: Object.fromEntries(
      exposed.map((t) => [
        t.name,
        Tool.make({
          description: t.description ?? "",
          input: (t.inputSchema ?? { type: "object" }) as Tool.JsonSchema,
          // Any JSON. Without an output schema codemode hands the script null.
          output: {},
          execute: (input: unknown) =>
            Effect.tryPromise({
              try: async () => {
                // Paths go as written: LocalForge refuses relative ones (relative_path) and returns absolute hits.
                const r = await o.call(t.name, input)
                const value = parse(textOf(r))
                if (!r.isError) return value?.result_too_large === true ? whole(value) : value
                if (!(value?.code && value?.message)) throw new Error(textOf(r))
                // An argument mistake: point at the notes the short tool line leaves out.
                const hint = value.code === "invalid_arguments" ? ` (argument notes: search("localforge.${t.name}"))` : ""
                throw new Error(`${value.code}: ${value.message}${hint}`)
              },
              catch: (e) => toolError(e instanceof Error ? e.message : String(e)),
            }),
        }),
      ]),
    ),
  }
  const description = describe(CodeMode.make({ tools: tree }).catalog, exposed, o)

  async function execute(code: string, options: { timeoutMs?: number; signal?: AbortSignal; session?: string } = {}) {
    const session = options.session ?? "default"
    const asked = options.timeoutMs
    const timeoutMs = Math.min(asked !== undefined && asked > 0 ? asked : o.timeoutMs, o.maxTimeoutMs)
    const started = Date.now()
    const calls: Row[] = []
    const rows = new WeakMap<object, Row>()
    // What inner calls handed the program, as JSON: compared with replyBytes it is what stayed out of context.
    let toolBytes = 0
    // keep() saves at once, so a value outlives a program that fails after keeping it.
    const state = Extension.make({
      name: "state",
      globals: {
        keep: (values: unknown) => {
          // Only a plain object: a Map, Set or array would pass typeof and keep nothing.
          const proto = typeof values === "object" && values !== null ? Object.getPrototypeOf(values) : undefined
          if (proto !== Object.prototype && proto !== null)
            throw new TypeError("keep takes a plain object: keep({ name: value })")
          const entries: Record<string, string> = {}
          for (const [name, value] of Object.entries(values as object)) {
            if (!keepable(name))
              throw new TypeError(
                `keep: "${name}" can't be a variable: not an identifier, or taken by a global in the program; pick another name`,
              )
            const json = JSON.stringify(value, asJson)
            if (json === undefined) throw new TypeError(`keep: "${name}" is not JSON data`)
            entries[name] = json
          }
          const bytes = Object.values(entries).reduce((n, json) => n + Buffer.byteLength(json), 0)
          if (bytes > store.maxBytes) throw new RangeError(`keep: ${bytes} bytes is over the ${store.maxBytes}-byte cap`)
          store.keep(session, entries)
        },
        forget: (name?: unknown) => store.forget(session, name === undefined ? undefined : String(name)),
      },
    })
    // A runtime per run, so concurrent runs keep separate call logs.
    const runtime = CodeMode.make({
      tools: tree,
      extensions: [state],
      limits: { timeoutMs, maxToolCalls: o.maxToolCalls, maxOutputBytes: VALUE_CEILING },
      hooks: {
        "tool.before": (call) =>
          Effect.sync(() => {
            const row: Row = { tool: call.name, status: "running", input: clip(safeJson(call.input), INPUT_CHARS) }
            rows.set(call, row)
            calls.push(row)
          }),
        "tool.after": (call, result) =>
          Effect.sync(() => {
            const row = rows.get(call)
            if (!row) return
            if (result.status === "success") toolBytes += Buffer.byteLength(safeJson(result.value))
            // Interrupted: the program ended (or timed out) before the call settled.
            row.status =
              result.status === "interrupted"
                ? "interrupted"
                : result.status === "success" && !failed(result.value)
                  ? "completed"
                  : "error"
          }),
      },
    })
    let result: { ok: boolean; error?: { kind: string; message: string } }
    let reply: { text: string; isError: boolean; spilled: boolean }
    const keptNow = () => {
      const names = store.names(session)
      return names.length ? { kept: names } : {}
    }
    try {
      const { toolCalls: _, ...done } = await Effect.runPromise(runtime.execute(code, store.values(session)), {
        signal: options.signal,
      })
      result = done
      reply = fit({ ...done, ...keptNow(), calls }, o)
    } catch (e) {
      // A cancelled run, or a failure in this server (e.g. the spill file can't be written): still a tool result.
      const cancelled = options.signal?.aborted === true
      const error = cancelled
        ? { kind: "Cancelled", message: "The run was cancelled." }
        : { kind: "InternalError", message: e instanceof Error ? e.message : String(e) }
      result = { ok: false, error }
      const head = { ok: false, error: clipError(error, o.maxOutputBytes), ...keptNow() }
      const part = keepCalls(calls, o.maxOutputBytes, (p) => ({ ...head, ...p }))
      reply = { text: JSON.stringify({ ...head, ...part }), isError: true, spilled: false }
    }
    if (o.historyFile) {
      const run = {
        at: new Date(started).toISOString(),
        ms: Date.now() - started,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error?.kind }),
        calls: calls.length,
        toolBytes,
        replyBytes: Buffer.byteLength(reply.text),
        spilled: reply.spilled,
        code,
      }
      try {
        mkdirSync(dirname(o.historyFile), { recursive: true })
        appendFileSync(o.historyFile, JSON.stringify(run) + "\n")
      } catch (e) {
        // The program's reply matters more than its history line.
        console.error(`localforge-codemode-mcp: could not write history: ${e}`)
      }
    }
    return { text: reply.text, isError: reply.isError }
  }

  return { description, execute }
}

function fit(reply: { ok: boolean; error?: { kind: string; message: string }; kept?: string[]; calls: Row[] }, o: Options) {
  const cap = o.maxOutputBytes
  const { counts, rows } = logOf(reply.calls, reply.ok)
  const { calls: _, ...rest } = reply
  const text = JSON.stringify({ ...rest, ...counts, calls: rows })
  const bytes = Buffer.byteLength(text)
  if (bytes <= cap) return { text, isError: !reply.ok, spilled: false }
  mkdirSync(o.spillDir, { recursive: true })
  const path = join(o.spillDir, `result-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`)
  writeFileSync(path, text)
  prune(o.spillDir)

  // ok, error and the path come first; then as many call rows as fit; the preview gets whatever room is left.
  // shortcut: a cap under ~1 KB, or an error message near the cap, can still go over it.
  const error = reply.error && clipError(reply.error, cap)
  const head = {
    ok: reply.ok,
    ...(error ? { error } : {}),
    ...(reply.kept ? { kept: reply.kept } : {}),
    spilled: { path, bytes },
    ...counts,
  }
  const part = keepCalls(rows, cap, (p) => ({ ...head, ...p, preview: "" }))
  const envelope = (preview: string) => ({ ...head, ...part, preview })
  // The longest start of the full reply whose JSON-escaped UTF-8 still fits; never more characters than bytes left.
  // A lone high surrogate escapes to 6 bytes, more than its whole pair (4), so the longest fit never splits a pair.
  const room = cap - bytesOf(envelope(""))
  let low = 0
  let high = Math.max(0, Math.min(text.length, room))
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytesOf(text.slice(0, mid)) - 2 <= room) low = mid
    else high = mid - 1
  }
  return { text: JSON.stringify(envelope(text.slice(0, low))), isError: !reply.ok, spilled: true }
}

// Names start with Date.now(), so name order is age order. Only this server's own files go, and a file that can't be
// removed now (open elsewhere) waits for a later run: pruning never fails a reply.
function prune(dir: string) {
  try {
    for (const name of readdirSync(dir).filter((n) => SPILLED.test(n)).sort().slice(0, -SPILL_KEEP))
      try {
        rmSync(join(dir, name), { force: true })
      } catch {}
  } catch {}
}

function describe(catalog: ReadonlyArray<{ signature: string; description: string }>, exposed: McpTool[], o: Options) {
  const rules = [
    "Run JavaScript on the user's PC that calls LocalForge tools; only its return value comes back: chain calls, shrink big results.",
    "`code` is plain JS: no code fence, imports, require, fetch or timers. Await every call (else interrupted); run independent ones with Promise.allSettled.",
    "Same JSON as direct LocalForge; a refused call rejects, a failed command resolves with success: false. Use absolute paths or an absolute cwd. Processes started here are only reachable here.",
    "keep({name: value}): JSON copies, consts in the session's later programs; forget(name?) drops. Background tasks: pass a unique session.",
    `Limits: ${Math.min(o.timeoutMs, o.maxTimeoutMs) / 1000} s (timeout_seconds, up to ${o.maxTimeoutMs / 1000}), ${o.maxToolCalls} calls. Reply: ok, value|error, logs, warnings, kept, calls [{tool, status, input}] (interrupted may still finish); if ok, completed calls only as completed {tool: n}. Over ${o.maxOutputBytes} bytes: spilled {path, bytes}, preview, the calls that fit; or return less.`,
  ]
  if (o.fullCatalog)
    return [
      ...rules,
      "",
      "Tools:",
      ...catalog.map((t) => `- ${t.signature} // ${clip(t.description.split("\n", 1)[0]!.trim(), DESCRIPTION_CHARS)}`),
    ].join("\n")
  const text = [
    ...rules,
    'Tools as tools.localforge.<name>; argument notes: return search("localforge.<tool>"):',
    ...exposed.map(compact),
  ].join("\n")
  if (text.length <= QUICK_LIMIT) return text
  // shortcut: a much bigger tool set loses its last tool lines; list tools through search() if that happens.
  console.error(
    `localforge-codemode-mcp: execute description cut from ${text.length} to ${QUICK_LIMIT} characters; the last tool lines are missing`,
  )
  return text.slice(0, QUICK_LIMIT - 3) + "..."
}
