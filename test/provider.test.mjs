import assert from "node:assert/strict"
import { test } from "node:test"
import { registerConsoleRequests } from "../src/provider.ts"

const API_URL = "https://api.anthropic.com/v1/messages"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const MINT_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const cred = (overrides = {}) => ({
  type: "oauth", methodID: "console", access: "access", refresh: "refresh",
  expires: Date.now() + 3_600_000, metadata: { apiKey: "sk-ant-console" }, ...overrides,
})

async function setup(initial = cred(), network) {
  let stored = initial
  let connection = { type: "credential", id: "account-1", label: "Console", method: "oauth" }
  const hooks = new Map()
  const calls = []
  const statuses = []
  await registerConsoleRequests({
    aisdk: { hook: async () => {} },
    session: { hook: async (name, callback) => { hooks.set(name, callback) } },
    integration: { connection: {
      active: async () => connection,
      resolve: async () => stored,
      status: async (input) => { statuses.push(input) },
    } },
  }, async (url, init) => {
    calls.push({ url: String(url), init })
    if (network) return network(url, init)
    if (String(url) === TOKEN_URL) return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    assert.equal(String(url), MINT_URL)
    return json({ raw_key: "sk-ant-minted" })
  })
  async function request(options = {}) {
    const event = {
      sessionID: "session", agent: "agent", kind: "primary", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      request: new Request(API_URL, { method: "POST", body: "{}", headers: { authorization: "Bearer placeholder", "content-type": "application/json" } }),
      ...options,
    }
    assert.ok(hooks.has("http.request"), "native HTTP request hook is registered")
    await hooks.get("http.request")(event)
    return event
  }
  async function response(event, status, headers = {}) {
    const value = json({ error: "upstream" }, status, headers)
    const result = { ...event, response: value }
    assert.ok(hooks.has("http.response"), "native HTTP response hook is registered")
    await hooks.get("http.response")(result)
    assert.equal(result.response, value)
    return value
  }
  return { hooks, request, response, calls, statuses, switchTo(value, id = "account-2") {
    stored = value
    connection = value ? { ...connection, id } : undefined
  } }
}

test("native requests authenticate with the Console key and preserve the payload", async () => {
  const app = await setup()
  const event = await app.request()
  assert.equal(event.request.headers.get("x-api-key"), "sk-ant-console")
  assert.equal(event.request.headers.get("authorization"), null)
  assert.equal(event.request.headers.get("content-type"), "application/json")
  assert.equal(event.request.headers.get("anthropic-version"), "2023-06-01")
  assert.equal(event.request.headers.get("x-claude-code-session-id"), null)
  assert.equal(event.request.headers.get("anthropic-dangerous-direct-browser-access"), null)
  assert.deepEqual(JSON.parse(await event.request.text()).system, [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
  ])
  assert.equal(app.calls.length, 0)
})

test("SDK beta and version headers survive native authentication", async () => {
  const app = await setup()
  const request = new Request(API_URL, { headers: { "anthropic-beta": "test-beta", "anthropic-version": "custom" } })
  const event = await app.request({ request })
  assert.equal(event.request.headers.get("anthropic-beta"), "test-beta")
  assert.equal(event.request.headers.get("anthropic-version"), "custom")
})

test("a usable API key does not require refreshing expired OAuth tokens", async () => {
  const app = await setup(cred({ expires: 0 }))
  await app.request()
  assert.equal(app.calls.length, 0)
})

test("concurrent native requests mint a missing key once", async () => {
  const app = await setup(cred({ metadata: undefined }))
  const events = await Promise.all(Array.from({ length: 8 }, () => app.request()))
  assert.equal(app.calls.length, 1)
  assert.equal(app.calls[0].url, MINT_URL)
  assert.ok(events.every((e) => e.request.headers.get("x-api-key") === "sk-ant-minted"))
})

test("rate limits and overloads pass through without retries or key rotation", async () => {
  const app = await setup()
  for (const status of [429, 529]) {
    const event = await app.request()
    const value = await app.response(event, status, { "retry-after": "60", "request-id": "req-test" })
    assert.equal(value.headers.get("retry-after"), "60")
    assert.equal(value.headers.get("request-id"), "req-test")
  }
  assert.equal(app.calls.length, 0)
})

test("401 responses invalidate the rejected key for the next request without replaying bodies", async () => {
  const app = await setup()
  const events = await Promise.all([app.request(), app.request()])
  await Promise.all(events.map((e) => app.response(e, 401)))
  assert.equal(app.calls.length, 0)
  const next = await Promise.all([app.request(), app.request()])
  assert.equal(app.calls.length, 1)
  assert.ok(next.every((e) => e.request.headers.get("x-api-key") === "sk-ant-minted"))
  await app.response(events[0], 401)
  await app.request()
  assert.equal(app.calls.length, 1, "a late response does not invalidate the new key")
})

test("other providers, origins, and connection methods pass through untouched", async () => {
  const app = await setup()
  for (const options of [
    { model: { providerID: "other" } },
    { request: new Request("https://example.com/v1/messages") },
    { request: new Request("http://api.anthropic.com/v1/messages") },
  ]) {
    const request = options.request ?? new Request(API_URL)
    const event = await app.request({ ...options, request })
    assert.equal(event.request, request)
  }
  for (const value of [undefined, { type: "key", key: "other" }, cred({ methodID: "subscription" })]) {
    app.switchTo(value)
    const request = new Request(API_URL)
    assert.equal((await app.request({ request })).request, request)
  }
  assert.equal(app.calls.length, 0)
})

test("switching accounts during a mint cannot restore the old account", async () => {
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  let started
  const starting = new Promise((resolve) => { started = resolve })
  const app = await setup(cred({ metadata: undefined }), async () => {
    started()
    await blocked
    return json({ raw_key: "sk-ant-obsolete" })
  })
  const pending = app.request()
  await starting
  app.switchTo(cred({ metadata: { apiKey: "sk-ant-selected" } }))
  release()
  assert.equal((await pending).request.headers.get("x-api-key"), "sk-ant-selected")
  assert.equal((await app.request()).request.headers.get("x-api-key"), "sk-ant-selected")
})

test("failed credential updates can be retried by a later request", async () => {
  let calls = 0
  const app = await setup(cred({ metadata: undefined }), async () => {
    if (++calls === 1) throw new Error("network down")
    return json({ raw_key: "sk-ant-recovered" })
  })
  await assert.rejects(app.request(), /network down/)
  assert.equal((await app.request()).request.headers.get("x-api-key"), "sk-ant-recovered")
})

test("an aborted native request does not start credential work", async () => {
  const app = await setup(cred({ metadata: undefined }))
  const request = new Request(API_URL, { signal: AbortSignal.abort() })
  await assert.rejects(app.request({ request }), { name: "AbortError" })
  assert.equal(app.calls.length, 0)
})

test("rate-limit diagnostics include retry timing and request ID without credentials", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "console-rate-limit-"))
  const previous = process.env.CONSOLE_LOGIN_DEBUG
  const path = join(directory, "debug.jsonl")
  process.env.CONSOLE_LOGIN_DEBUG = path
  try {
    const app = await setup()
    const event = await app.request()
    await app.response(event, 429, { "retry-after": "60", "request-id": "req-test" })
    const raw = await readFile(path, "utf8")
    const entry = JSON.parse(raw)
    assert.equal(entry.status, 429)
    assert.equal(entry.retryAfter, "60")
    assert.equal(entry.requestId, "req-test")
    assert.doesNotMatch(raw, /sk-ant-console|Bearer|placeholder/)
  } finally {
    if (previous === undefined) delete process.env.CONSOLE_LOGIN_DEBUG
    else process.env.CONSOLE_LOGIN_DEBUG = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test("native header replacement preserves a streaming request body and its abort signal", async () => {
  const app = await setup()
  const controller = new AbortController()
  const stream = new ReadableStream({ start(output) {
    output.enqueue(new TextEncoder().encode("streamed payload"))
    output.close()
  } })
  const event = await app.request({ request: new Request(API_URL, {
    method: "POST", body: stream, duplex: "half", signal: controller.signal,
  }) })
  assert.equal(await event.request.text(), "streamed payload")
  controller.abort()
  assert.equal(event.request.signal.aborted, true)
})


test("a rejected key is replaced using the stored access token, and a host-stored new key wins", async () => {
  const app = await setup(cred({ access: "stored-access" }))
  await app.response(await app.request(), 401)
  assert.equal((await app.request()).request.headers.get("x-api-key"), "sk-ant-minted")
  assert.equal(app.calls[0].init.headers.Authorization, "Bearer stored-access")
  app.switchTo(cred({ metadata: { apiKey: "sk-ant-from-refresh" } }), "account-1")
  assert.equal((await app.request()).request.headers.get("x-api-key"), "sk-ant-from-refresh")
  assert.equal(app.calls.length, 1)
})

test("switching away and back keeps a connection's replacement key", async () => {
  const original = cred()
  const app = await setup(original)
  await app.response(await app.request(), 401)
  await app.request()
  app.switchTo(cred({ metadata: { apiKey: "sk-ant-account-b" } }), "account-2")
  assert.equal((await app.request()).request.headers.get("x-api-key"), "sk-ant-account-b")
  app.switchTo(structuredClone(original), "account-1")
  assert.equal((await app.request()).request.headers.get("x-api-key"), "sk-ant-minted")
  assert.equal(app.calls.length, 1)
})
