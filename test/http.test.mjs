import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { fetchWithRetry, parseRetryAfter } from "../src/http.ts"

const res = (status, headers = {}) => new Response("", { status, headers })

afterEach(() => {
  delete process.env.CONSOLE_LOGIN_MAX_RETRY_MS
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
  process.env.CONSOLE_LOGIN_MAX_RETRY_MS = "10"
  let calls = 0
  const fetchImpl = async () => (calls++, res(429, { "retry-after": "5" }))
  const out = await fetchWithRetry("http://x", {}, 3, fetchImpl)
  assert.equal(out.status, 429)
  assert.equal(calls, 1)
})

test("an aborted login request never reaches the network", async () => {
  let calls = 0
  await assert.rejects(
    fetchWithRetry("https://example.com", { signal: AbortSignal.abort() }, 3, async () => { calls++; return res(200) }),
    { name: "AbortError" },
  )
  assert.equal(calls, 0)
})

test("retrying a login response releases its body before the next attempt", async () => {
  let cancelled = false
  let calls = 0
  const first = new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 429, headers: { "retry-after": "0" } })
  const result = await fetchWithRetry("https://example.com", {}, 3, async () => {
    if (++calls === 1) return first
    assert.equal(cancelled, true)
    return res(200)
  })
  assert.equal(result.status, 200)
})

test("cancellation during Retry-After rejects without another network attempt", async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = fetchWithRetry("https://example.com", { signal: controller.signal }, 3, async () => {
    calls++
    queueMicrotask(() => controller.abort())
    return res(429, { "retry-after": "1" })
  })
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(calls, 1)
})
