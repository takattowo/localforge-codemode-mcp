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
| `timeoutMs` | `60000` | Per program |
| `maxTimeoutMs` | `300000` | Most a program may ask for with `timeout_seconds` |
| `maxToolCalls` | `50` | Per program |
| `maxOutputBytes` | `30000` | Bigger replies are saved to `spillDir` and returned as a path and preview |
| `spillDir` | `<repo>/.spill` | Keep it inside LocalForge's read roots so the model can read spilled files |
| `fullCatalog` | `false` | List full signatures with every argument's notes (~15.7k characters for LocalForge). Quick cuts tool descriptions at about 2,048 characters, so keep it off there; the default is one short line per tool, under 2,000 characters, and `search()` in a program returns the notes either way |
| `historyFile` | `<repo>/.history/runs.jsonl` | One line per run: code, outcome, calls, `toolBytes` (what inner calls returned) and `replyBytes` (what the model got). `null` turns it off |

`batch`, `todo` and `workspace` are never exposed: a program already runs calls in parallel or in order, and `batch`
would count as one call against `maxToolCalls` and the call log.

## Safety

Quick approves the `execute` call as a whole, not each LocalForge command inside it. Give `execute` the same
permission rule as your LocalForge tools, or set `allowShell: false`. LocalForge's `denied_paths` does not block
shell commands, with or without this server.

## Limits

- Inner calls must name absolute locations: filesystem `path` and `destination`, the `path` of a search and of each multi_search entry, git and execute `cwd`, process start `cwd`. Relative or missing ones are refused with `relative_path`, because LocalForge has one working folder per server, shared by every chat and task. On Windows a path starting with a single `\` or `/` counts as relative: it follows the current drive. Search results come back with absolute paths when the server could read LocalForge's working folder at startup (it logs to stderr when it couldn't).
- A single regex match can't be interrupted by the timeout.
- On timeout, an inner LocalForge call keeps running in LocalForge; only the program stops waiting for it.
- If LocalForge exits, every later call fails until Quick restarts this server.
- Spilled files and the history file are never cleaned up.
- A call still running when a program ends shows as `interrupted`; LocalForge may still finish it.
- Cancelling a call in Quick stops the program and sends no reply, but a LocalForge command already running keeps going.
- With `maxOutputBytes` under about 1 KB, a reply can still go over the cap.
- Relative paths in `codemode.json` are resolved from the folder that holds it.
- The default description has only about 10 characters left under 2,000; if LocalForge grows, the last tool lines are cut, a warning goes to stderr, and the end-to-end test fails.
