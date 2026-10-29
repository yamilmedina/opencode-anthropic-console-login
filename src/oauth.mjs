// Ported from https://github.com/jvortmann/pi-anthropic-console-login (MIT).
import { spawn } from "node:child_process"
import { createServer } from "node:http"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const SCOPES = "org:create_api_key user:profile"

export const CALLBACK_PORT = 53693
const CALLBACK_HOST = "127.0.0.1"
const CALLBACK_PATH = "/callback"
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`

// Retry logic for rate limits
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs() {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

function sleepUnlessAborted(ms, signal) {
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

async function fetchWithRetry(input, init, retries = 3, fetchImpl = fetch) {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delay = Number.isNaN(parsed) ? (i + 1) * 2000 : parsed * 1000
      if (delay > getMaxRetryDelayMs()) {
        return res
      }
      await sleepUnlessAborted(delay, init?.signal)
      if (init?.signal?.aborted) {
        return res
      }
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}

export async function generatePKCE() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const challenge = Buffer.from(hash).toString("base64url")
  return { verifier, challenge }
}

export function parseAuthorizationInput(input) {
  const value = input.trim()
  if (!value) return {}

  try {
    const url = new URL(value)
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined }
  } catch {}

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code, state }
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined }
  }

  return { code: value }
}

export function buildAuthorizeUrl({ challenge, state, redirectUri }) {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })
  return `${AUTHORIZE_URL}?${params}`
}

export async function exchangeCode({ code, state, verifier, redirectUri, fetchFn = fetch }) {
  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  }, 3, fetchFn)
  
  if (!response.ok) throw new Error(`Token exchange failed: ${await response.text()}`)
  const { access_token } = await response.json()
  return access_token
}

export async function createApiKey(oauthAccessToken, fetchFn = fetch) {
  const response = await fetchWithRetry(API_KEY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${oauthAccessToken}` },
  }, 3, fetchFn)
  
  if (!response.ok) throw new Error(`API key creation failed: ${await response.text()}`)
  const { raw_key } = await response.json()
  if (!raw_key) throw new Error("API key creation returned no key")
  return raw_key
}

const page = (title, color, message) =>
  `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0"><div style="text-align:center"><h2 style="color:${color}">${title}</h2><p>${message}</p></div></body></html>`

function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let settle
    const codePromise = new Promise((resolveCode) => {
      settle = resolveCode
    })

    const reply = (res, status, html) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://localhost")
      if (url.pathname !== CALLBACK_PATH) return reply(res, 404, page("Not found", "#e74c3c", "Callback route not found."))

      const error = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (error) return reply(res, 400, page("Authentication failed", "#e74c3c", `Error: ${error}`))
      if (!code || !state) return reply(res, 400, page("Authentication failed", "#e74c3c", "Missing code or state."))
      if (state !== expectedState) return reply(res, 400, page("Authentication failed", "#e74c3c", "State mismatch."))

      reply(res, 200, page("Authentication complete", "#4ecca3", "You can close this window and return to OpenCode."))
      settle({ code, state })
    })

    server.once("error", reject)
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve({ server, codePromise }))
  })
}

function open(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replaceAll("&", "^&")]]
        : ["xdg-open", [url]]
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
}

export async function login({ fetchFn = fetch, openUrl = open, log = console.error, timeoutMs = 5 * 60 * 1000 } = {}) {
  const { verifier, challenge } = await generatePKCE()

  const { server, codePromise } = await startCallbackServer(verifier).catch((error) => {
    throw new Error(`Cannot listen on port ${CALLBACK_PORT} for the login callback: ${error.message}`)
  })

  let timer
  try {
    const authUrl = buildAuthorizeUrl({ challenge, state: verifier, redirectUri: REDIRECT_URI })
    log(`Open this URL to sign in to the Anthropic Console:\n${authUrl}`)
    await Promise.resolve(openUrl(authUrl)).catch(() => {})

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for the browser login.")), timeoutMs)
    })
    const { code, state } = await Promise.race([codePromise, timeout])

    const oauthAccess = await exchangeCode({ code, state, verifier, redirectUri: REDIRECT_URI, fetchFn })
    return await createApiKey(oauthAccess, fetchFn)
  } finally {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
}
