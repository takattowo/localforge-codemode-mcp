# localforge-codemode-mcp

Code mode for [LocalForge](https://github.com/takattowo/localforge-mcp): an MCP server with one tool, `execute`. The
model sends a JavaScript program; the program calls LocalForge as `await tools.localforge.<tool>({...})`, and only its
return value goes back. Programs run in
[`@opencode/codemode`](https://www.npmjs.com/package/@opencode/codemode) (MIT), a confined JS-subset interpreter, so
they reach the outside only through those tools.

LocalForge itself is unchanged. This server starts its own LocalForge child with the same command and env as your
Quick connection, so roots, denied paths and mode still apply to every inner call.

## Setup

```powershell
bun install
Copy-Item codemode.example.json codemode.json   # then point mcpConfig at Quick's mcp_config.json
bun test
bun run typecheck
```

Add a Local MCP connection in Quick:

```json
"localforge-codemode-mcp": {
  "command": "C:\\Users\\<you>\\.bun\\bin\\bun.exe",
  "args": ["run", "<repo>\\src\\server.ts"]
}
```

Use the full `bun.exe` path: Quick's PATH may not include `.bun\bin`. Restart Quick after adding it.

## Config (`codemode.json`, or the path in `LOCALFORGE_CODEMODE_CONFIG`)

| Key | Default | |
| --- | --- | --- |
| `mcpConfig` | required | Quick's `mcp_config.json`; the LocalForge entry is read from it |
| `server` | `localforge-mcp` | Entry name in `mcpServers` |
| `allowShell` | `true` | Expose `execute` and `process` to programs |
| `timeoutMs` | `120000` | Per program |
| `maxTimeoutMs` | `280000` | Most a program may ask for with `timeout_seconds`. Quick ends a tool call at 300 s, so keep it under that |
| `maxToolCalls` | `1000` | Per program |
| `maxOutputBytes` | `30000` | Bigger replies are saved to `spillDir` and returned as a path and preview |
| `spillDir` | `<repo>/.spill` | Keep it inside LocalForge's read roots so the model can read spilled files |
| `fullCatalog` | `false` | List full signatures with every argument's notes (~15.7k characters for LocalForge). Quick cuts tool descriptions at about 2,048 characters, so keep it off there; the default is one short line per tool, under 2,000 characters, and `search()` in a program returns the notes either way |
| `historyFile` | `<repo>/.history/runs.jsonl` | One line per run: code, outcome, calls, `toolBytes` (what inner calls returned) and `replyBytes` (what the model got). `null` turns it off |

`batch`, `todo` and `workspace` are never exposed: a program already runs calls in parallel or in order, and `batch`
would count as one call against `maxToolCalls` and the call log.

## Kept values

`keep({ files, hits })` saves plain JSON data; every later program in the same session gets each name as a constant
(a program can still declare its own variable with that name). `keep` takes a plain object, not a `Map`, `Set` or
array. A kept `Set` comes back as an array and a `Map` as a plain object; a function is left out without an error;
a `Date` is kept as its ISO string; an `undefined` value is refused, and then nothing in that call is kept.
`forget("files")` drops one, `forget()` all of the session. While a session has values, the reply lists their names
under `kept`. `execute` takes
an optional `session` string (default `default`): one server serves every chat and task, so background tasks should
pass a unique one. Two runs at the same time in one session each see the values from their own start, and the last
`keep()` of a name wins.

## Safety

Quick approves the `execute` call as a whole, not each LocalForge command inside it. Give `execute` the same
permission rule as your LocalForge tools, or set `allowShell: false`. LocalForge's `denied_paths` does not block
shell commands, with or without this server.

## Limits

- Calls go to LocalForge as written. Needs localforge-mcp 1.11.0 or later, whose `require_absolute_paths` (on by default) refuses relative or missing locations with `relative_path` and returns absolute search hits; LocalForge has one working folder per server, shared by every chat and task. With that setting off, relative paths use LocalForge's working folder.
- A single regex match can't be interrupted by the timeout.
- A LocalForge result over its `max_result_bytes` reaches the program whole, read from the copy LocalForge saved at
  `result_path`, not as LocalForge's cut reply; if that copy can't be read, the call fails instead.
- On timeout, an inner LocalForge call keeps running in LocalForge; only the program stops waiting for it.
- If LocalForge exits, the calls in flight fail and the next call starts it again; if that start fails, the calls waiting on it fail too and the one after tries again. A restarted LocalForge's tool list is read before those calls run, so later programs get its new tools; Quick sees the new description the next time it lists tools.
- Only the newest 100 spilled replies (`result-*.json` in `spillDir`) are kept; the history file is never cleaned up.
- A call still running when a program ends shows as `interrupted`; LocalForge may still finish it.
- When a program succeeds, the reply lists only the calls that failed (including commands with `success: false`) or were interrupted (`tool`, `status`, `input`); completed calls are only counted per tool, under `completed`, keyed like `tool` (`localforge.git`). A failed, timed-out or cancelled run keeps every call's row, since it has no value to show what already happened. The history file keeps the program's code.
- Cancelling a call in Quick stops the program and sends no reply, but a LocalForge command already running keeps going.
- With `maxOutputBytes` under about 1 KB, a reply can still go over the cap.
- Kept values live in memory only: a restart of this server (or of Quick) loses them; a LocalForge restart does not. They are copies: changing the original later does not change what was kept. `keep()` saves at once, so a value outlives a program that fails afterwards, and values are bound when a program starts, so `keep()` and `forget()` show from the next program on. All sessions together hold at most 50 MB of JSON; past that, the least recently kept values go first, from any session, and a single `keep()` over 50 MB is refused. Names must be identifiers not taken by a global in the program (`tools`, `search`, `keep`, `forget`, `require`, `JSON`, `Map`, ...); globals only this server has, such as `self`, `process`, `fetch` or `setTimeout`, are free.
- Relative paths in `codemode.json` are resolved from the folder that holds it.
- The default description has about 100 characters left under 2,000. The end-to-end test fails once fewer than 100 are left; past 2,000 the last tool lines are cut and a warning goes to stderr.
