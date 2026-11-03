import { oauthFetch } from "./oauth-transport.ts"
// OAuth flow reference: https://github.com/jvortmann/pi-anthropic-console-login (MIT).
// See LICENSE for copyright notices.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { fetchWithRetry } from "./http.ts"
import type { TokenResponse } from "./credentials.ts"

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize"
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const SCOPES = "org:create_api_key user:profile"

export const CALLBACK_PORT = 53693
const CALLBACK_HOST = "127.0.0.1"
const CALLBACK_PATH = "/callback"
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const challenge = Buffer.from(hash).toString("base64url")
  return { verifier, challenge }
}

export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
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

export function buildAuthorizeUrl({
  challenge,
  state,
  redirectUri,
}: {
  challenge: string
  state: string
  redirectUri: string
}): string {
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

export async function exchangeTokens({
  code,
  state,
  verifier,
  redirectUri,
  fetchFn = oauthFetch,
}: {
  code: string
  state: string
  verifier: string
  redirectUri: string
  fetchFn?: typeof fetch
}): Promise<TokenResponse> {
  // Authorization codes are single-use; do not retry the token exchange.
  const response = await fetchFn(TOKEN_URL, {
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
  })

  if (!response.ok) {
    const details = `HTTP ${response.status}; Retry-After: ${response.headers.get("retry-after") ?? "not provided"}; Request ID: ${response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? "not provided"}`
    throw new Error(`Token exchange failed: ${await response.text()}\n${details}`)
  }
  return (await response.json()) as TokenResponse
}

export async function exchangeCode(args: Parameters<typeof exchangeTokens>[0]): Promise<string> {
  return (await exchangeTokens(args)).access_token
}

export async function createApiKey(oauthAccessToken: string, fetchFn: typeof fetch = oauthFetch): Promise<string> {
  const response = await fetchWithRetry(API_KEY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${oauthAccessToken}` },
  }, 3, fetchFn)
  
  if (!response.ok) throw new Error(`API key creation failed: ${await response.text()}`)
  const { raw_key } = await response.json()
  if (!raw_key) throw new Error("API key creation returned no key")
  return raw_key
}

const page = (title: string, color: string, message: string): string =>
  `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0"><div style="text-align:center"><h2 style="color:${color}">${title}</h2><p>${message}</p></div></body></html>`

interface CallbackServerResult {
  server: ReturnType<typeof createServer>
  codePromise: Promise<{ code: string; state: string }>
}

function startCallbackServer(expectedState: string): Promise<CallbackServerResult> {
  return new Promise((resolve, reject) => {
    let settle: (value: { code: string; state: string }) => void
    const codePromise = new Promise<{ code: string; state: string }>((resolveCode) => {
      settle = resolveCode
    })

    const reply = (res: any, status: number, html: string) => {
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

function open(url: string): void {
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

export async function beginLogin(options?: {
  fetchFn?: typeof fetch
  openUrl?: (url: string) => Promise<void> | void
  log?: (message: string) => void
  timeoutMs?: number
}): Promise<{ url: string; result: Promise<{ tokens: TokenResponse; apiKey: string }> }> {
  const { fetchFn = oauthFetch, openUrl = open, log = console.error, timeoutMs = 5 * 60 * 1000 } = options ?? {}

  const { verifier, challenge } = await generatePKCE()

  const { server, codePromise } = await startCallbackServer(verifier).catch((error: Error) => {
    throw new Error(`Cannot listen on port ${CALLBACK_PORT} for the login callback: ${error.message}`)
  })

  const url = buildAuthorizeUrl({ challenge, state: verifier, redirectUri: REDIRECT_URI })
  log(`Open this URL to sign in to the Anthropic Console:\n${url}`)

  let timer: NodeJS.Timeout | undefined
  const result = (async () => {
    try {
      await Promise.resolve(openUrl(url)).catch(() => {})
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for the browser login.")), timeoutMs)
      })
      const { code, state } = await Promise.race([codePromise, timeout])
      const tokens = await exchangeTokens({ code, state, verifier, redirectUri: REDIRECT_URI, fetchFn })
      return { tokens, apiKey: await createApiKey(tokens.access_token, fetchFn) }
    } finally {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections()
    }
  })()
  return { url, result }
}

export async function login(options?: Parameters<typeof beginLogin>[0]): Promise<string> {
  const { result } = await beginLogin(options)
  return (await result).apiKey
}
