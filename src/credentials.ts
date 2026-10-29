import { createApiKey } from "./oauth.ts"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export type OAuthCredential = {
  type: "oauth"
  methodID: string
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, unknown>
}

export type TokenResponse = { access_token: string; refresh_token: string; expires_in?: number }

export function toCredential(
  tokens: TokenResponse,
  methodID: string,
  apiKey: string,
  now: number = Date.now(),
): OAuthCredential {
  return {
    type: "oauth",
    methodID,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    metadata: { apiKey },
  }
}

export function apiKeyOf(cred: OAuthCredential): string | undefined {
  const key = cred.metadata?.apiKey
  return typeof key === "string" && key !== "" ? key : undefined
}

export async function mintKey(cred: OAuthCredential, fetchFn: typeof fetch = fetch): Promise<OAuthCredential> {
  const apiKey = await createApiKey(cred.access, fetchFn)
  return { ...cred, metadata: { ...cred.metadata, apiKey } }
}

export async function refreshCredential(
  cred: OAuthCredential,
  fetchFn: typeof fetch = fetch,
): Promise<OAuthCredential> {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: cred.refresh,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) throw new Error("Console session expired; run /connect and sign in again")

  const tokens = (await response.json()) as TokenResponse
  return mintKey(
    {
      ...cred,
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? cred.refresh,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    },
    fetchFn,
  )
}

export function isExpiring(cred: OAuthCredential, now: number = Date.now()): boolean {
  return now >= cred.expires - EXPIRY_MARGIN_MS
}
