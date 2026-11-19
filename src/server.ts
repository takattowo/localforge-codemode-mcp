import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { connect, serve } from "./mcp"
import { createRunner, type McpTool } from "./runner"

const VERSION = "0.1.0"
// shortcut: 2025-03-26 allowed JSON-RPC batches, which serve() answers with one -32600; add batch support if a client sends them.
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
const root = join(import.meta.dir, "..")
const configPath = resolve(process.env.LOCALFORGE_CODEMODE_CONFIG ?? join(root, "codemode.json"))
const config = JSON.parse(readFileSync(configPath, "utf8"))
if (typeof config !== "object" || config === null || Array.isArray(config))
  throw new Error(`${configPath} must hold a JSON object`)
// Relative paths in the config are relative to the config file, not to wherever the host started this server.
const fromConfig = (path: string) => resolve(dirname(configPath), path)

// LocalForge starts with the same command and env as the host's own connection to it.
const serverName = config.server ?? "localforge-mcp"
if (typeof config.mcpConfig !== "string") throw new Error(`mcpConfig is required in ${configPath}`)
const mcpConfig = fromConfig(config.mcpConfig)
const entry = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers?.[serverName]
if (!entry?.command) throw new Error(`No "${serverName}" server with a command in ${mcpConfig}`)
const localforge = connect(
  [entry.command, ...(entry.args ?? [])],
  { ...process.env, ...entry.env },
  { name: "localforge-codemode-mcp", version: VERSION },
  // A restarted LocalForge may be a newer one: programs after it get its tools. A failed list keeps the old ones.
  // shortcut: Quick isn't sent notifications/tools/list_changed; it sees the new description when it lists tools again.
  async (client) => {
    try {
      runner = build((await client.request("tools/list")).tools)
    } catch (e) {
      console.error(`localforge-codemode-mcp: could not read the restarted LocalForge's tools: ${e}`)
    }
  },
)

const timeoutMs = config.timeoutMs ?? 60_000
const maxTimeoutMs = config.maxTimeoutMs ?? 300_000
const build = (tools: McpTool[]) =>
  createRunner({
    tools,
    call: (name, args) => localforge.request("tools/call", { name, arguments: args }),
    allowShell: config.allowShell ?? true,
    timeoutMs,
    maxTimeoutMs,
    maxToolCalls: config.maxToolCalls ?? 50,
    maxOutputBytes: config.maxOutputBytes ?? 30_000,
    // Inside the repo by default, so LocalForge's read roots can reach spilled results.
    spillDir: config.spillDir ? fromConfig(config.spillDir) : join(root, ".spill"),
    fullCatalog: config.fullCatalog ?? false,
    // null turns the history off.
    historyFile:
      config.historyFile === null
        ? undefined
        : config.historyFile
          ? fromConfig(config.historyFile)
          : join(root, ".history", "runs.jsonl"),
  })
let runner = build((await localforge.request("tools/list")).tools)

const executeTool = () => ({
  name: "execute",
  description: runner.description,
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The JavaScript program to run." },
      timeout_seconds: {
        type: "number",
        description: `Time limit for this program in seconds (default ${Math.min(timeoutMs, maxTimeoutMs) / 1000}, max ${maxTimeoutMs / 1000}).`,
      },
    },
    required: ["code"],
  },
})

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })

await serve(async (method, params, signal) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "localforge-codemode-mcp", version: VERSION },
      }
    case "ping":
      return {}
    case "tools/list":
      return { tools: [executeTool()] }
    case "tools/call": {
      if (params?.name !== "execute") throw rpcError(-32602, `Unknown tool: ${params?.name}`)
      const code = params.arguments?.code
      if (typeof code !== "string") {
        const text = '{"ok":false,"error":{"kind":"InvalidInput","message":"code must be a string"}}'
        return { content: [{ type: "text", text }], isError: true }
      }
      const seconds = params.arguments?.timeout_seconds
      const reply = await runner.execute(code, { signal, ...(typeof seconds === "number" ? { timeoutMs: seconds * 1000 } : {}) })
      return { content: [{ type: "text", text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    }
    default:
      throw rpcError(-32601, "Method not found")
  }
})
localforge.close()
