import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { nodeFetch } from "../src/oauth-transport.ts"

test("OAuth transport uses Node request defaults and preserves upstream errors", async () => {
  let calls = 0
  const server = createServer(async (req, res) => {
    calls++
    assert.equal(req.headers["user-agent"], "node")
    assert.equal(req.headers["content-type"], "application/json")
    let body = ""
    for await (const chunk of req) body += chunk
    assert.deepEqual(JSON.parse(body), { code: "local-test-code" })
    res.writeHead(429, { "content-type": "application/json", "retry-after": "60", "request-id": "req-test" })
    res.end(JSON.stringify({ error: { type: "rate_limit_error" } }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const response = await nodeFetch(`http://127.0.0.1:${server.address().port}/token`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "local-test-code" }),
    })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get("retry-after"), "60")
    assert.equal(response.headers.get("request-id"), "req-test")
    assert.deepEqual(await response.json(), { error: { type: "rate_limit_error" } })
    assert.equal(calls, 1)
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test("OAuth transport rejects an already aborted request", async () => {
  await assert.rejects(nodeFetch("http://127.0.0.1:1/token", { signal: AbortSignal.abort() }), { name: "AbortError" })
})

test("cancelling an in-flight OAuth request stops waiting for the Node transport", async () => {
  let started
  const starting = new Promise((resolve) => { started = resolve })
  const server = createServer(() => { started() })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const controller = new AbortController()
    const pending = nodeFetch(`http://127.0.0.1:${server.address().port}/token`, { signal: controller.signal })
    await starting
    controller.abort()
    await assert.rejects(pending, { name: "AbortError" })
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
