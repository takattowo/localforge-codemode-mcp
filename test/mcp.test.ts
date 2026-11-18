import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect, startClient, lines } from "../src/mcp"

const dir = mkdtempSync(join(tmpdir(), "localforge-codemode-mcp-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A fake MCP server: waits for 4 requests, then sends junk and a request of its own, answers 3, 2, 1 in that order
// (the last with no trailing newline), never answers 4, and exits.
const FAKE = `
const requests = []
const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let end
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) requests.push(JSON.parse(line))
  }
  if (requests.length >= 4) break
}
const reply = (id) => JSON.stringify({ jsonrpc: "2.0", id, result: { echo: id } })
await Bun.write(Bun.stdout, ["null", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }), reply(3), reply(2)].join("\\n") + "\\n" + reply(1))
process.exit(0)
`

test("client matches out-of-order replies, ignores junk and server requests, and fails calls when the child exits", async () => {
  const script = join(dir, "fake.ts")
  writeFileSync(script, FAKE)
  const client = startClient([process.execPath, script], process.env)
  const calls = [1, 2, 3, 4].map(() => client.request("tools/call").then((r) => r, (e: Error) => e.message))
  const [one, two, three, four] = await Promise.all(calls)
  expect(one).toEqual({ echo: 1 })
  expect(two).toEqual({ echo: 2 })
  expect(three).toEqual({ echo: 3 })
  expect(four).toBe("LocalForge exited")
  expect(await client.request("ping").catch((e: Error) => e.message)).toBe("LocalForge is not running")
}, 20_000)

// A fake LocalForge: answers initialize, exits on a call named "die", and answers any other call with its pid and
// whether it was sent notifications/initialized first.
const MORTAL = `
let initialized = false
const decoder = new TextDecoder()
let buffer = ""
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let end
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18" } })
    else if (m.method === "notifications/initialized") initialized = true
    else if (m.params?.name === "die") process.exit(1)
    else send({ jsonrpc: "2.0", id: m.id, result: { pid: process.pid, initialized } })
  }
}
`

test("connect starts LocalForge again on the next call after it exits", async () => {
  const script = join(dir, "mortal.ts")
  writeFileSync(script, MORTAL)
  const localforge = connect([process.execPath, script], process.env, { name: "test", version: "0" })
  const first = await localforge.request("tools/call", { name: "stat" })
  expect(first.initialized).toBe(true)
  // The call in flight when it exits still fails.
  expect(await localforge.request("tools/call", { name: "die" }).catch((e: Error) => e.message)).toBe("LocalForge exited")
  // Calls made together after the exit share one fresh, initialized LocalForge.
  const [a, b] = await Promise.all([1, 2].map(() => localforge.request("tools/call", { name: "stat" })))
  expect(a.pid).not.toBe(first.pid)
  expect(b.pid).toBe(a.pid)
  expect(a.initialized).toBe(true)
  await localforge.close()
}, 20_000)

// A server on serve(): "slow" waits until cancelled, anything else answers "pong".
const SERVER = (mcp: string) => `
import { serve } from ${JSON.stringify(mcp)}
await serve(async (method, _params, signal) => {
  if (method === "slow") {
    await new Promise((resolve) => signal.addEventListener("abort", resolve))
    return "late"
  }
  return "pong"
})
`

test("serve rejects non-object messages and sends nothing for a cancelled request", async () => {
  const script = join(dir, "server.ts")
  writeFileSync(script, SERVER(join(import.meta.dir, "..", "src", "mcp.ts").replaceAll("\\", "/")))
  const server = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
  const send = (m: unknown) => server.stdin.write(JSON.stringify(m) + "\n")
  send(null)
  send([1])
  send({ jsonrpc: "2.0", id: 1, method: "slow" })
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })
  send({ jsonrpc: "2.0", id: 2, method: "ping" })
  server.stdin.end()
  const replies: any[] = []
  for await (const line of lines(server.stdout)) replies.push(JSON.parse(line))
  expect(await server.exited).toBe(0)
  expect(replies.filter((m) => m.id === null).map((m) => m.error.code)).toEqual([-32600, -32600])
  expect(replies.some((m) => m.id === 1)).toBe(false)
  expect(replies.find((m) => m.id === 2)?.result).toBe("pong")
}, 20_000)
