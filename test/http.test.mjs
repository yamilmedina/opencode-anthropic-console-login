import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { describeRateLimit, fetchWithRetry, parseRetryAfter } from "../src/http.ts"

const res = (status, headers = {}) => new Response("", { status, headers })

afterEach(() => {
  delete process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
})

test("parseRetryAfter reads seconds, dates and rejects garbage", () => {
  assert.equal(parseRetryAfter("7"), 7000)
  assert.equal(parseRetryAfter("0"), 0)
  assert.equal(parseRetryAfter("-3"), undefined)
  assert.equal(parseRetryAfter("abc"), undefined)
  assert.equal(parseRetryAfter(null), undefined)
  const now = Date.parse("2026-01-01T00:00:00Z")
  assert.equal(parseRetryAfter(new Date(now + 10_000).toUTCString(), now), 10_000)
  assert.equal(parseRetryAfter(new Date(now - 10_000).toUTCString(), now), 0)
})

test("fetchWithRetry retries a 429 with retry-after 0 then returns 200", async () => {
  let calls = 0
  const fetchImpl = async () => (++calls === 1 ? res(429, { "retry-after": "0" }) : res(200))
  const out = await fetchWithRetry("http://x", {}, 3, fetchImpl)
  assert.equal(out.status, 200)
  assert.equal(calls, 2)
})

test("fetchWithRetry returns the 429 untouched when retry-after exceeds the max", async () => {
  process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS = "10"
  let calls = 0
  const fetchImpl = async () => (calls++, res(429, { "retry-after": "5" }))
  const out = await fetchWithRetry("http://x", {}, 3, fetchImpl)
  assert.equal(out.status, 429)
  assert.equal(calls, 1)
})

test("fetchWithRetry stops when the signal is aborted", async () => {
  let calls = 0
  const fetchImpl = async () => (calls++, res(429, { "retry-after": "0" }))
  const out = await fetchWithRetry("http://x", { signal: AbortSignal.abort() }, 3, fetchImpl)
  assert.equal(out.status, 429)
  assert.equal(calls, 1)
})

test("describeRateLimit says the limit is organization-wide", () => {
  assert.match(describeRateLimit(res(429)), /organization/)
  assert.match(describeRateLimit(res(429, { "retry-after": "60" })), /organization.*60/s)
})
