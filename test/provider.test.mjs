import assert from "node:assert/strict"
import { test } from "node:test"
import { createConsoleFetch, registerConsoleRequests } from "../src/provider.ts"

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const MINT_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const API_URL = "https://api.anthropic.com/v1/messages"

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const cred = (over = {}) => ({
  type: "oauth", methodID: "console", access: "acc", refresh: "ref",
  expires: Date.now() + 3_600_000, metadata: { apiKey: "sk-ant-old" }, ...over,
})

// Fake network. apiResponses are consumed in order for API_URL calls.
function setup(initial, apiResponses = [() => json({ ok: true })]) {
  let current = initial
  const saved = []
  const calls = []
  const base = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u === MINT_URL) return json({ raw_key: `sk-ant-minted-${calls.filter((c) => c.url === MINT_URL).length}` })
    if (u === TOKEN_URL) return json({ access_token: "acc2", refresh_token: "ref2", expires_in: 3600 })
    const next = apiResponses.length > 1 ? apiResponses.shift() : apiResponses[0]
    return next()
  }
  const f = createConsoleFetch(async () => current, async (c) => { current = c; saved.push(c) }, base)
  const api = () => calls.filter((c) => c.url === API_URL)
  const count = (url) => calls.filter((c) => c.url === url).length
  return { f, saved, api, count }
}

test("injects x-api-key from metadata.apiKey and replaces any existing one", async () => {
  const { f, api } = setup(cred())
  await f(API_URL, { method: "POST", headers: { "x-api-key": "placeholder", "content-type": "application/json" }, body: "{}" })
  const h = new Headers(api()[0].init.headers)
  assert.equal(h.get("x-api-key"), "sk-ant-old")
  assert.equal(h.get("authorization"), null)
  assert.equal(h.get("content-type"), "application/json")
  assert.equal(h.get("x-app"), "opencode")
  assert.ok(h.get("user-agent"))
})

test("credential without apiKey mints one before the first call and saves it", async () => {
  const { f, api, count, saved } = setup(cred({ metadata: undefined }))
  await f(API_URL, { method: "POST", body: "{}" })
  assert.equal(count(MINT_URL), 1)
  assert.equal(new Headers(api()[0].init.headers).get("x-api-key"), "sk-ant-minted-1")
  assert.equal(saved.length, 1)
})

test("expiring credential is refreshed once before the call", async () => {
  const { f, api, count, saved } = setup(cred({ expires: Date.now() + 1000 }))
  await f(API_URL, { method: "POST", body: "{}" })
  await f(API_URL, { method: "POST", body: "{}" })
  assert.equal(count(TOKEN_URL), 1)
  assert.equal(saved[0].access, "acc2")
  assert.equal(new Headers(api()[1].init.headers).get("x-api-key"), "sk-ant-minted-1")
})

test("401 re-mints exactly once and retries once; a second 401 is returned", async () => {
  const { f, api, count } = setup(cred(), [() => json({}, 401)])
  const res = await f(API_URL, { method: "POST", body: "{}" })
  assert.equal(res.status, 401)
  assert.equal(count(MINT_URL), 1)
  assert.equal(api().length, 2)
  assert.equal(new Headers(api()[1].init.headers).get("x-api-key"), "sk-ant-minted-1")
})

test("401 followed by success returns the success", async () => {
  const { f, count } = setup(cred(), [() => json({}, 401), () => json({ ok: true })])
  const res = await f(API_URL, { method: "POST", body: "{}" })
  assert.equal(res.status, 200)
  assert.equal(count(MINT_URL), 1)
})

test("429 with retry-after above the max is returned after one base call", async () => {
  const { f, api } = setup(cred(), [() => json({}, 429, { "retry-after": "3600" })])
  const res = await f(API_URL, { method: "POST", body: "{}" })
  assert.equal(res.status, 429)
  assert.equal(api().length, 1)
})

test("string and stream bodies reach base unchanged", async () => {
  const { f, api } = setup(cred())
  await f(API_URL, { method: "POST", body: '{"a":1}' })
  assert.equal(api()[0].init.body, '{"a":1}')
  const stream = new ReadableStream()
  await f(API_URL, { method: "POST", body: stream, duplex: "half" })
  assert.equal(api()[1].init.body, stream)
})

test("no credential: request is passed through untouched", async () => {
  const calls = []
  const f = createConsoleFetch(async () => undefined, async () => {}, async (u, i) => { calls.push(i); return json({}) })
  await f(API_URL, { method: "POST", headers: { "x-api-key": "other" } })
  assert.equal(calls[0].headers["x-api-key"], "other")
})

test("registerConsoleRequests hooks the anthropic sdk options with a fetch", async () => {
  const hooks = []
  const stored = cred()
  const ctx = {
    aisdk: { hook: async (name, cb, opts) => hooks.push({ name, cb, opts }) },
    integration: {
      connection: {
        active: async () => ({ id: "c1" }),
        resolve: async () => stored,
        status: async () => {},
      },
    },
  }
  await registerConsoleRequests(ctx)
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].name, "sdk")
  assert.deepEqual(hooks[0].opts, { providerID: "anthropic" })
  const options = {}
  hooks[0].cb({ model: {}, package: "@ai-sdk/anthropic", options })
  assert.equal(typeof options.fetch, "function")
})
