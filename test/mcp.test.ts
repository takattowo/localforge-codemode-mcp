import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startClient } from "../src/mcp"

const dir = mkdtempSync(join(tmpdir(), "codemode-mcp-test-"))
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
