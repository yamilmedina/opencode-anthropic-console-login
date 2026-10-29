import { setTimeout as pause } from "node:timers/promises"
import { log } from "./logger.ts"

export type FetchFn = typeof fetch

const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs(): number {
  const env = process.env.CONSOLE_LOGIN_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

/** Milliseconds to wait per a Retry-After header (seconds or HTTP-date); undefined if missing or invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return undefined
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  const signal = init?.signal ?? undefined
  for (let i = 0; i < Math.max(1, retries); i++) {
    signal?.throwIfAborted()
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const delay = parseRetryAfter(retryAfter) ?? (i + 1) * 2000
      if (delay > getMaxRetryDelayMs()) {
        log("fetch_rate_limited_quota", {
          status: res.status,
          retryAfter: retryAfter ?? "none",
          delayMs: delay,
        })
        return res
      }
      log("fetch_rate_limited", {
        status: res.status,
        attempt: i + 1,
        retryAfter: retryAfter ?? "none",
        delayMs: delay,
      })
      await res.body?.cancel()
      await pause(delay, undefined, { signal })
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}
