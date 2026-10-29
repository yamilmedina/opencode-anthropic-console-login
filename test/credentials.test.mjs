import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getOrCreateApiKey,
  isOAuthTokenExpired,
  refreshOAuthToken,
  validateCredentialFormat,
} from "../src/credentials.ts"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

test("getOrCreateApiKey creates new key if none cached", async () => {
  const credential = { accessToken: "oauth-token" }
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ raw_key: "sk-ant-new-key-1" })
  }
  
  const key = await getOrCreateApiKey(credential, fetchFn)
  
  assert.equal(key, "sk-ant-new-key-1")
  assert.equal(credential._cachedApiKey, "sk-ant-new-key-1")
  assert.ok(credential._lastApiKeyCreatedAt)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://api.anthropic.com/api/oauth/claude_cli/create_api_key")
})

test("getOrCreateApiKey reuses key within 1 hour", async () => {
  const now = Date.now()
  const credential = {
    accessToken: "oauth-token",
    _cachedApiKey: "sk-ant-cached-key",
    _lastApiKeyCreatedAt: now - 30 * 60 * 1000, // 30 minutes ago
  }
  const fetchFn = async () => {
    throw new Error("Should not call createApiKey")
  }
  
  const key = await getOrCreateApiKey(credential, fetchFn)
  
  assert.equal(key, "sk-ant-cached-key")
})

test("getOrCreateApiKey creates new key after 1 hour expires", async () => {
  const now = Date.now()
  const credential = {
    accessToken: "oauth-token",
    _cachedApiKey: "sk-ant-old-key",
    _lastApiKeyCreatedAt: now - 61 * 60 * 1000, // 61 minutes ago
  }
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ raw_key: "sk-ant-new-key-2" })
  }
  
  const key = await getOrCreateApiKey(credential, fetchFn)
  
  assert.equal(key, "sk-ant-new-key-2")
  assert.equal(credential._cachedApiKey, "sk-ant-new-key-2")
  assert.ok(credential._lastApiKeyCreatedAt > now - 61 * 60 * 1000)
  assert.equal(calls.length, 1)
})

test("isOAuthTokenExpired returns false initially, true after 95% of lifetime", () => {
  const now = Date.now()
  
  // Token with 1 hour lifetime, created just now
  const fresh = {
    accessToken: "token",
    oauthTokenCreatedAt: now,
    expiresAt: now + 3600 * 1000,
  }
  assert.equal(isOAuthTokenExpired(fresh), false)
  
  // Token at exactly 95% of lifetime consumed
  const almostExpired = {
    accessToken: "token",
    oauthTokenCreatedAt: now - 3420 * 1000, // 95% of 3600 seconds
    expiresAt: now + 180 * 1000, // 5% remaining
  }
  assert.equal(isOAuthTokenExpired(almostExpired), true)
  
  // Token at 94% of lifetime consumed (not expired yet)
  const almostFresh = {
    accessToken: "token",
    oauthTokenCreatedAt: now - 3384 * 1000, // 94% of 3600 seconds
    expiresAt: now + 216 * 1000, // 6% remaining
  }
  assert.equal(isOAuthTokenExpired(almostFresh), false)
  
  // Token with no expiry info
  const noExpiry = {
    accessToken: "token",
  }
  assert.equal(isOAuthTokenExpired(noExpiry), false)
})

test("refreshOAuthToken exchanges refresh token for new access token", async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      access_token: "new-oauth-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    })
  }
  
  const refreshToken = "old-refresh-token"
  const credential = await refreshOAuthToken(refreshToken, fetchFn)
  
  assert.equal(credential.accessToken, "new-oauth-token")
  assert.equal(credential.refreshToken, "new-refresh-token")
  assert.ok(credential.expiresAt)
  assert.ok(credential.oauthTokenCreatedAt)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://platform.claude.com/v1/oauth/token")
  assert.equal(calls[0].init.method, "POST")
  
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.grant_type, "refresh_token")
  assert.equal(body.refresh_token, "old-refresh-token")
  assert.equal(body.client_id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e")
})

test("validateCredentialFormat accepts valid credential, rejects invalid ones", () => {
  // Valid credential
  const valid = { accessToken: "token" }
  assert.deepEqual(validateCredentialFormat(valid), valid)
  
  // Valid credential with optional fields
  const validFull = {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: 12345,
    oauthTokenCreatedAt: 12345,
    _cachedApiKey: "key",
    _lastApiKeyCreatedAt: 12345,
  }
  assert.deepEqual(validateCredentialFormat(validFull), validFull)
  
  // Missing accessToken
  assert.equal(validateCredentialFormat({ refreshToken: "r" }), null)
  
  // accessToken is not a string
  assert.equal(validateCredentialFormat({ accessToken: 123 }), null)
  
  // Not an object
  assert.equal(validateCredentialFormat("not-an-object"), null)
  assert.equal(validateCredentialFormat(null), null)
  assert.equal(validateCredentialFormat(undefined), null)
})
