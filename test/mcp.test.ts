import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

// A fake LocalForge. Each start adds a line to the file in argv[2]; the start whose number is in argv[3] waits 300 ms
// after its first request, then exits before answering initialize. Otherwise it answers initialize, exits on a call
// named "die", and answers any other call with a token made at startup and whether notifications/initialized came first.
const MORTAL = `
import { appendFileSync, readFileSync } from "node:fs"
const [log, failOn] = process.argv.slice(2)
appendFileSync(log, "start\\n")
const starts = readFileSync(log, "utf8").trim().split("\\n").length
const token = crypto.randomUUID()
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
    if (String(starts) === failOn) {
      await Bun.sleep(300)
      process.exit(1)
    }
    const m = JSON.parse(line)
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18" } })
    else if (m.method === "notifications/initialized") initialized = true
    else if (m.params?.name === "die") process.exit(1)
    else send({ jsonrpc: "2.0", id: m.id, result: { token, initialized } })
  }
}
`
const mortal = (name: string, failOn = 0) => {
  const script = join(dir, "mortal.ts")
  writeFileSync(script, MORTAL)
  const log = join(dir, name + ".log")
  writeFileSync(log, "")
  const starts = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
  return { command: [process.execPath, script, log, String(failOn)], starts }
}
const message = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message)

test("connect starts LocalForge again on the next call after it exits", async () => {
  const fake = mortal("restart")
  const localforge = connect(fake.command, process.env, { name: "test", version: "0" })
  const first = await localforge.request("tools/call", { name: "stat" })
  expect(first.initialized).toBe(true)
  // The call in flight when it exits still fails.
  expect(await message(localforge.request("tools/call", { name: "die" }))).toBe("LocalForge exited")
  // Calls made together after the exit share one fresh, initialized LocalForge.
  const [a, b] = await Promise.all([1, 2].map(() => localforge.request("tools/call", { name: "stat" })))
  expect(a.token).not.toBe(first.token)
  expect(b.token).toBe(a.token)
  expect(a.initialized).toBe(true)
  expect(fake.starts()).toBe(2)
  localforge.close()
}, 20_000)

test("a start that fails fails the calls waiting on it, and the next call starts again", async () => {
  // Start 2 (the first restart) dies before answering initialize.
  const fake = mortal("failed-start", 2)
  const localforge = connect(fake.command, process.env, { name: "test", version: "0" })
  await localforge.request("tools/call", { name: "stat" })
  await message(localforge.request("tools/call", { name: "die" }))
  // The first call starts the restart; the second arrives while it is still starting. Both share its failure, and
  // neither starts another child.
  const first = message(localforge.request("tools/call", { name: "stat" }))
  await Bun.sleep(100)
  const second = message(localforge.request("tools/call", { name: "stat" }))
  expect(await Promise.all([first, second])).toEqual(["LocalForge exited", "LocalForge exited"])
  expect(fake.starts()).toBe(2)
  const next = await localforge.request("tools/call", { name: "stat" })
  expect(next.initialized).toBe(true)
  expect(fake.starts()).toBe(3)
  localforge.close()
}, 20_000)

test("after close, calls fail and nothing starts LocalForge again", async () => {
  const fake = mortal("close")
  const localforge = connect(fake.command, process.env, { name: "test", version: "0" })
  const pending = localforge.request("tools/call", { name: "stat" })
  localforge.close()
  // A call already waiting on the start does not get a fresh child either.
  expect(await message(pending)).toBe("LocalForge is not running")
  expect(await message(localforge.request("tools/call", { name: "stat" }))).toBe("LocalForge is not running")
  await Bun.sleep(300)
  expect(fake.starts()).toBe(1)
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
