import { CodeMode, Tool, toolError } from "@opencode/codemode"
import { Effect } from "effect"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

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
  /** LocalForge's own working folder: relative result paths from search and multi_search are made absolute with it. */
  cwd?: string
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
// Error messages in a capped reply get at most an eighth of the cap.
const clipError = (e: { kind: string; message: string }, cap: number) => ({
  kind: e.kind,
  message: clip(e.message, Math.floor(cap / 8)),
})
const failed = (v: any) => typeof v === "object" && v !== null && v.success === false

// LocalForge has one working folder per server, shared by every chat and task (a set_cwd anywhere moves it), so a
// relative path or a missing cwd could land in another session's repo. Inner calls must name absolute locations.
const DRIVE_OR_UNC = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/
// One leading slash names a root only on POSIX; on Windows it follows the current drive, which moves with the shared
// working folder. LocalForge's working folder tells which applies; without one, the host OS does.
const isAbsolute = (p: string, cwd: string | undefined) =>
  DRIVE_OR_UNC.test(p) || ((cwd !== undefined ? cwd.startsWith("/") : process.platform !== "win32") && p.startsWith("/"))
const SHARED = " (LocalForge's working folder is shared with other chats, so a relative one could hit another repo)"
// Each argument that names a location, with LocalForge's aliases, and whether the call needs one.
const LOCATIONS: Record<string, Array<{ keys: string[]; required: (input: any) => boolean }>> = {
  filesystem: [
    { keys: ["path", "file", "target"], required: () => true },
    { keys: ["destination", "dest"], required: () => false },
  ],
  search: [{ keys: ["path"], required: () => true }],
  git: [{ keys: ["cwd"], required: () => true }],
  execute: [{ keys: ["cwd"], required: () => true }],
  process: [{ keys: ["cwd"], required: (input) => input.action === "start" }],
}
// filesystem and search (and each multi_search entry) may instead name relative paths under an absolute cwd.
const CWD_RULE: (typeof LOCATIONS)[string] = [{ keys: ["cwd"], required: () => true }]
const locationProblem = (tool: string, where: string, input: any, cwd: string | undefined) => {
  const underCwd = tool === "filesystem" || tool === "search"
  const rules = underCwd && input.cwd != null ? CWD_RULE : LOCATIONS[tool]!
  const or = (k: string) => (underCwd && k !== "cwd" ? " (or an absolute cwd)" : "")
  for (const { keys, required } of rules) {
    // null means "not given", as LocalForge treats it.
    const given = keys.filter((k) => input[k] != null)
    if (given.length === 0 && required(input))
      return `relative_path: ${where} needs an absolute ${keys[0]}${or(keys[0]!)}${SHARED}`
    for (const k of given) {
      const v = input[k]
      if (typeof v !== "string" || !isAbsolute(v, cwd))
        return `relative_path: ${where} ${k} must be an absolute path, got ${clip(safeJson(v), 80)}${or(k)}${SHARED}`
    }
  }
  return undefined
}
const pathProblem = (tool: string, input: any, cwd: string | undefined): string | undefined => {
  if (!input || typeof input !== "object") return undefined
  if (tool === "multi_search") {
    const searches = Array.isArray(input.searches) ? input.searches : []
    for (const [i, s] of searches.entries()) {
      const problem = locationProblem("search", `localforge.multi_search searches[${i}]`, s ?? {}, cwd)
      if (problem) return problem
    }
    return undefined
  }
  return LOCATIONS[tool] ? locationProblem(tool, `localforge.${tool}`, input, cwd) : undefined
}
// LocalForge shows result paths under the folder a search ran from (the call's cwd, else its own) relative to it;
// a program only sees absolute ones.
const absolutePaths = (tool: string, value: any, input: any, cwd: string | undefined) => {
  if (!value || typeof value !== "object") return value
  const fix = (results: unknown, own: unknown) => {
    const from = typeof own === "string" ? own : cwd
    if (!from || !Array.isArray(results)) return
    const sep = from.includes("\\") ? "\\" : "/"
    const base = from.replace(/[\\/]+$/, "")
    for (const r of results)
      if (r && typeof r === "object" && typeof r.path === "string" && !isAbsolute(r.path, cwd))
        r.path = base + sep + r.path.replace(/[\\/]/g, sep)
  }
  if (tool === "search") fix(value.results, input?.cwd)
  if (tool === "multi_search" && Array.isArray(value.results))
    value.results.forEach((e: any, i: number) => fix(e?.results, input?.searches?.[i]?.cwd))
  return value
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

export function createRunner(o: Options) {
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
                const problem = pathProblem(t.name, input, o.cwd)
                if (problem) throw new Error(problem)
                const r = await o.call(t.name, input)
                const value = parse(textOf(r))
                if (!r.isError) return absolutePaths(t.name, value, input, o.cwd)
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

  async function execute(code: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const asked = options.timeoutMs
    const timeoutMs = Math.min(asked !== undefined && asked > 0 ? asked : o.timeoutMs, o.maxTimeoutMs)
    const started = Date.now()
    const calls: Row[] = []
    const rows = new WeakMap<object, Row>()
    // What inner calls handed the program, as JSON: compared with replyBytes it is what stayed out of context.
    let toolBytes = 0
    // A runtime per run, so concurrent runs keep separate call logs.
    const runtime = CodeMode.make({
      tools: tree,
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
    try {
      const { toolCalls: _, ...done } = await Effect.runPromise(runtime.execute(code), { signal: options.signal })
      result = done
      reply = fit({ ...done, calls }, o)
    } catch (e) {
      // A cancelled run, or a failure in this server (e.g. the spill file can't be written): still a tool result.
      const cancelled = options.signal?.aborted === true
      const error = cancelled
        ? { kind: "Cancelled", message: "The run was cancelled." }
        : { kind: "InternalError", message: e instanceof Error ? e.message : String(e) }
      result = { ok: false, error }
      const head = { ok: false, error: clipError(error, o.maxOutputBytes) }
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

function fit(reply: { ok: boolean; error?: { kind: string; message: string }; calls: Row[] }, o: Options) {
  const cap = o.maxOutputBytes
  const { counts, rows } = logOf(reply.calls, reply.ok)
  const { calls: _, ...rest } = reply
  const text = JSON.stringify({ ...rest, ...counts, calls: rows })
  const bytes = Buffer.byteLength(text)
  if (bytes <= cap) return { text, isError: !reply.ok, spilled: false }
  mkdirSync(o.spillDir, { recursive: true })
  // shortcut: spilled files are never cleaned up; add pruning if the folder grows.
  const path = join(o.spillDir, `result-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`)
  writeFileSync(path, text)

  // ok, error and the path come first; then as many call rows as fit; the preview gets whatever room is left.
  // shortcut: a cap under ~1 KB, or an error message near the cap, can still go over it.
  const error = reply.error && clipError(reply.error, cap)
  const head = { ok: reply.ok, ...(error ? { error } : {}), spilled: { path, bytes }, ...counts }
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

function describe(catalog: ReadonlyArray<{ signature: string; description: string }>, exposed: McpTool[], o: Options) {
  const rules = [
    "Run JavaScript on the user's PC that calls LocalForge tools; only its return value comes back. Use it to chain calls and shrink big results.",
    "JavaScript in `code`, no code fence; no imports, require, fetch or timers. End with `return` of only what you need. Await every call (pending ones are interrupted); run independent calls with Promise.allSettled.",
    "Calls take and return the same JSON as direct LocalForge. A refused call rejects; a failed command resolves with success: false. Name absolute paths or an absolute cwd. Processes started here are only reachable here.",
    ...(o.allowShell ? ["Write shell commands as literal strings or argv arrays, not built from tool results."] : []),
    `Limits: ${Math.min(o.timeoutMs, o.maxTimeoutMs) / 1000} s (timeout_seconds, up to ${o.maxTimeoutMs / 1000}) and ${o.maxToolCalls} calls. Reply: ok, value or error, logs, warnings, calls [{tool, status, input}], interrupted may still finish; if ok, completed calls only as completed {tool: n}. Over ${o.maxOutputBytes} bytes it goes to a file: spilled {path, bytes}, preview and the calls that fit; or return less.`,
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
    'Tools, called as tools.localforge.<name>; argument notes: return search("localforge.<tool>"):',
    ...exposed.map(compact),
  ].join("\n")
  if (text.length <= QUICK_LIMIT) return text
  // shortcut: a much bigger tool set loses its last tool lines; list tools through search() if that happens.
  console.error(
    `localforge-codemode-mcp: execute description cut from ${text.length} to ${QUICK_LIMIT} characters; the last tool lines are missing`,
  )
  return text.slice(0, QUICK_LIMIT - 3) + "..."
}
