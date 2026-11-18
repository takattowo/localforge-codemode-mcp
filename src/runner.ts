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
const failed = (v: any) => typeof v === "object" && v !== null && v.success === false
// A schema without its notes: only string `description` keywords go, so an argument named description stays.
const withoutNotes = (s: any): any =>
  Array.isArray(s)
    ? s.map(withoutNotes)
    : s && typeof s === "object"
      ? Object.fromEntries(
          Object.entries(s)
            .filter(([k, v]) => !(k === "description" && typeof v === "string"))
            .map(([k, v]) => [k, withoutNotes(v)]),
        )
      : s

export function createRunner(o: Options) {
  const exposed = o.tools.filter((t) => !HIDDEN.has(t.name) && (o.allowShell || !SHELL.has(t.name)))
  const build = (schemaOf: (t: McpTool) => object) =>
    Object.fromEntries(
      exposed.map((t) => [
        t.name,
        Tool.make({
          description: t.description ?? "",
          input: schemaOf(t) as Tool.JsonSchema,
          // Any JSON. Without an output schema codemode hands the script null.
          output: {},
          execute: (input: unknown) =>
            Effect.tryPromise({
              try: async () => {
                const r = await o.call(t.name, input)
                const value = parse(textOf(r))
                if (!r.isError) return value
                throw new Error(value?.code && value?.message ? `${value.code}: ${value.message}` : textOf(r))
              },
              catch: (e) => toolError(e instanceof Error ? e.message : String(e)),
            }),
        }),
      ]),
    )
  const full = (t: McpTool) => t.inputSchema ?? { type: "object" }
  // Programs run against the full schemas, so search() inside a program still shows every argument's notes.
  const tree = { localforge: build(full) }
  const listed = o.fullCatalog ? tree : { localforge: build((t) => withoutNotes(full(t))) }
  const description = describe(CodeMode.make({ tools: listed }).catalog, o)

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
      reply = { text: JSON.stringify({ ok: false, error, calls }), isError: true, spilled: false }
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
        console.error(`localforge-codemode: could not write history: ${e}`)
      }
    }
    return { text: reply.text, isError: reply.isError }
  }

  return { description, execute }
}

function fit(reply: { ok: boolean; error?: { kind: string; message: string }; calls: Row[] }, o: Options) {
  const cap = o.maxOutputBytes
  const text = JSON.stringify(reply)
  const bytes = Buffer.byteLength(text)
  if (bytes <= cap) return { text, isError: !reply.ok, spilled: false }
  mkdirSync(o.spillDir, { recursive: true })
  // shortcut: spilled files are never cleaned up; add pruning if the folder grows.
  const path = join(o.spillDir, `result-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`)
  writeFileSync(path, text)

  // ok, error and the path come first; then as many call rows as fit; the preview gets whatever room is left.
  // shortcut: a cap under ~1 KB, or an error message near the cap, can still go over it.
  const error = reply.error && { kind: reply.error.kind, message: clip(reply.error.message, Math.floor(cap / 8)) }
  const head = { ok: reply.ok, ...(error ? { error } : {}), spilled: { path, bytes } }
  let calls = reply.calls
  const envelope = (preview: string) => ({
    ...head,
    calls,
    ...(calls.length < reply.calls.length ? { callsOmitted: reply.calls.length - calls.length } : {}),
    preview,
  })
  while (calls.length > 0 && bytesOf(envelope("")) > cap) calls = calls.slice(0, -1)
  // The longest start of the full reply whose JSON-escaped UTF-8 still fits; never more characters than bytes left.
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

function describe(catalog: ReadonlyArray<{ signature: string; description: string }>, o: Options) {
  const shell = o.allowShell
  return [
    "Run a JavaScript program on the user's PC that calls LocalForge tools, and get back only its return value. Use it to chain dependent calls in one step and to cut big results (search hits, file contents, command output) down before they reach you.",
    "Send plain JavaScript (not TypeScript) in `code`, without a code fence. There are no imports, require, fetch, timers or direct file access: everything outside goes through the `tools.localforge.*` functions listed below, which take the same arguments and return the same JSON as the direct LocalForge tools.",
    "End with an explicit `return` of only what you need. Await every call that matters: calls still pending when the program ends are interrupted. Run independent calls together with `Promise.allSettled`.",
    "A refused or invalid call (for example path_denied) rejects its promise, so catch it or use allSettled. A command that runs but fails resolves normally with `success: false`; check it.",
    ...(shell ? ["Write shell commands as literal strings or argv arrays in the program; do not build them from tool results."] : []),
    "Use absolute paths. Processes started here belong to this server: wait on or stop them from here, not with the direct LocalForge tools.",
    ...(o.fullCatalog
      ? []
      : [
          'Argument notes are left out below. When unsure about an argument (its unit, format or limits), `search("localforge.<tool>")` inside a program returns that tool\'s full signature with notes; it counts as a tool call.',
        ]),
    `Limits: ${Math.min(o.timeoutMs, o.maxTimeoutMs) / 1000} s per program (pass timeout_seconds, up to ${o.maxTimeoutMs / 1000}, for long builds or tests) and ${o.maxToolCalls} tool calls.`,
    "The reply is JSON: ok, then value or error, logs and warnings when there are any, and calls, which lists every tool call with its status: completed, error (including ones the program caught), or interrupted (still running when the program ended; LocalForge may still finish it).",
    `A reply over ${o.maxOutputBytes} bytes is saved to a file instead. You then get ok, error (if any), spilled {path, bytes}, the calls that fit (callsOmitted counts the rest) and preview, the start of the full reply; read the file with LocalForge filesystem read, or return less.`,
    "",
    "Tools:",
    ...catalog.map((t) => `- ${t.signature} // ${clip(t.description.split("\n", 1)[0]!.trim(), DESCRIPTION_CHARS)}`),
  ].join("\n")
}
