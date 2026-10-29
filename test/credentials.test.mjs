import assert from "node:assert/strict"
import { test } from "node:test"
import { apiKeyOf, mintKey, refreshCredential, renewCredential, toCredential } from "../src/credentials.ts"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const baseCred = () => ({
  type: "oauth",
  methodID: "console",
  access: "old-access",
  refresh: "old-refresh",
  expires: 1000,
  metadata: { apiKey: "sk-ant-old", other: "keep" },
})

test("toCredential builds an OAuth credential with the key in metadata", () => {
  const cred = toCredential(
    { access_token: "a", refresh_token: "r", expires_in: 100 },
    "console",
    "sk-ant-1",
    5000,
  )
  assert.deepEqual(cred, {
    type: "oauth",
    methodID: "console",
    access: "a",
    refresh: "r",
    expires: 5000 + 100 * 1000,
    metadata: { apiKey: "sk-ant-1" },
  })
})

test("toCredential defaults expires_in to 3600 seconds", () => {
  const cred = toCredential({ access_token: "a", refresh_token: "r" }, "console", "k", 0)
  assert.equal(cred.expires, 3600 * 1000)
})

test("apiKeyOf returns the stored key, undefined without metadata", () => {
  assert.equal(apiKeyOf(baseCred()), "sk-ant-old")
  const { metadata, ...noMeta } = baseCred()
  assert.equal(apiKeyOf(noMeta), undefined)
  assert.equal(apiKeyOf({ ...noMeta, metadata: {} }), undefined)
  assert.equal(apiKeyOf({ ...noMeta, metadata: { apiKey: "" } }), undefined)
  assert.equal(apiKeyOf({ ...noMeta, metadata: { apiKey: 5 } }), undefined)
})

test("mintKey returns a copy with a new key and does not mutate the input", async () => {
  const cred = baseCred()
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ raw_key: "sk-ant-new" })
  }
  const next = await mintKey(cred, fetchFn)
  assert.equal(apiKeyOf(next), "sk-ant-new")
  assert.equal(next.metadata.other, "keep")
  assert.equal(next.access, "old-access")
  assert.notEqual(next, cred)
  assert.equal(cred.metadata.apiKey, "sk-ant-old")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Authorization, "Bearer old-access")
})

test("mintKey works on a credential without metadata", async () => {
  const { metadata, ...noMeta } = baseCred()
  const next = await mintKey(noMeta, async () => jsonResponse({ raw_key: "sk-ant-new" }))
  assert.equal(apiKeyOf(next), "sk-ant-new")
})

test("refreshCredential refreshes tokens and preserves an existing API key", async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    if (String(url) === "https://platform.claude.com/v1/oauth/token") {
      return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 })
    }
    return jsonResponse({ raw_key: "sk-ant-new" })
  }
  const before = Date.now()
  const next = await refreshCredential(baseCred(), fetchFn)
  assert.equal(next.methodID, "console")
  assert.equal(next.type, "oauth")
  assert.equal(next.access, "new-access")
  assert.equal(next.refresh, "new-refresh")
  assert.ok(next.expires >= before + 60 * 1000)
  assert.equal(apiKeyOf(next), "sk-ant-old")

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.grant_type, "refresh_token")
  assert.equal(body.refresh_token, "old-refresh")
  assert.equal(body.client_id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e")
  assert.equal(calls.length, 1)
})

test("revoked refresh grants produce a sign-in-again message", async () => {
  const fetchFn = async () => jsonResponse({ error: "invalid_grant" }, 400)
  await assert.rejects(
    () => refreshCredential(baseCred(), fetchFn),
    (err) => {
      assert.equal(err.message, "Console session expired; run /connect and sign in again")
      return true
    },
  )
})

test("temporary refresh failures do not ask the user to sign in again", async () => {
  await assert.rejects(refreshCredential(baseCred(), async () => jsonResponse({}, 503)), (error) => {
    assert.match(error.message, /503/)
    assert.doesNotMatch(error.message, /sign in again/)
    return true
  })
})

test("refresh respects a long Retry-After without rotating the key", async () => {
  let calls = 0
  await assert.rejects(refreshCredential(baseCred(), async () => {
    calls++
    return new Response("limited", { status: 429, headers: { "retry-after": "3600" } })
  }), /429/)
  assert.equal(calls, 1)
})

const TOKEN = "https://platform.claude.com/v1/oauth/token"
const tokens = () => jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 })

test("renewCredential rotates tokens and mints a fresh key", async () => {
  const next = await renewCredential(baseCred(), async (url) =>
    String(url) === TOKEN ? tokens() : jsonResponse({ raw_key: "sk-ant-fresh" }))
  assert.equal(next.refresh, "new-refresh")
  assert.equal(apiKeyOf(next), "sk-ant-fresh")
})

test("renewCredential keeps the existing key when the refresh fails", async () => {
  const cred = baseCred()
  assert.equal(await renewCredential(cred, async () => jsonResponse({}, 400)), cred)
})

test("renewCredential throws when refresh fails and no key exists", async () => {
  const { metadata, ...noKey } = baseCred()
  await assert.rejects(renewCredential(noKey, async () => jsonResponse({}, 400)), /sign in again/)
})

test("renewCredential keeps rotated tokens and the old key when minting fails", async () => {
  const next = await renewCredential(baseCred(), async (url) =>
    String(url) === TOKEN ? tokens() : jsonResponse({}, 503))
  assert.equal(next.refresh, "new-refresh")
  assert.equal(apiKeyOf(next), "sk-ant-old")
})
