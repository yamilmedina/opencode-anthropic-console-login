import { log } from "./logger.ts"

export type FetchFn = typeof fetch

const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", finish, { once: true })
  })
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

export function describeRateLimit(res: Response): string {
  const ms = parseRetryAfter(res.headers.get("retry-after"))
  const base = `Anthropic rate limit (HTTP ${res.status}). The limit is organization-wide, so another API key will not help.`
  if (ms === undefined) return base
  return `${base} Resets at ${new Date(Date.now() + ms).toISOString()} (retry-after ${Math.ceil(ms / 1000)}s).`
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
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
      await sleepUnlessAborted(delay, init?.signal)
      if (init?.signal?.aborted) {
        log("fetch_retry_aborted", { status: res.status })
        return res
      }
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}
