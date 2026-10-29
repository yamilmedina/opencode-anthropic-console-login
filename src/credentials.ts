import { oauthFetch } from "./oauth-transport.ts"
import { Integration, type Credential } from "@opencode/plugin"
import { CLIENT_ID, TOKEN_URL, createApiKey } from "./oauth.ts"
import { fetchWithRetry } from "./http.ts"
import { log } from "./logger.ts"

export type OAuthCredential = Credential.OAuth

export type TokenResponse = { access_token: string; refresh_token: string; expires_in?: number }

export function toCredential(
  tokens: TokenResponse,
  methodID: string,
  apiKey: string,
  now: number = Date.now(),
): OAuthCredential {
  return {
    type: "oauth",
    methodID: Integration.MethodID.make(methodID),
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

export async function mintKey(cred: OAuthCredential, fetchFn: typeof fetch = oauthFetch): Promise<OAuthCredential> {
  const apiKey = await createApiKey(cred.access, fetchFn)
  return { ...cred, metadata: { ...cred.metadata, apiKey } }
}

export async function refreshCredential(
  cred: OAuthCredential,
  fetchFn: typeof fetch = oauthFetch,
): Promise<OAuthCredential> {
  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: cred.refresh,
      client_id: CLIENT_ID,
    }),
  }, 3, fetchFn)
  if (response.status === 400 || response.status === 401) {
    throw new Error("Console session expired; run /connect and sign in again")
  }
  if (!response.ok) throw new Error(`Console token refresh failed (HTTP ${response.status})`)

  const tokens = (await response.json()) as TokenResponse
  const next = {
    ...cred,
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? cred.refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }
  return next
}

/**
 * OpenCode calls this shortly before `expires` and stores the result, so it is the only
 * place rotated tokens and a new key persist. Like Pi, mint a fresh key with each refresh.
 * A failure keeps whatever still works: an existing key, or the rotated tokens.
 */
export async function renewCredential(
  cred: OAuthCredential,
  fetchFn: typeof fetch = oauthFetch,
): Promise<OAuthCredential> {
  let next: OAuthCredential
  try {
    next = await refreshCredential(cred, fetchFn)
  } catch (error) {
    if (!apiKeyOf(cred)) throw error
    log("console_refresh_failed", { message: error instanceof Error ? error.message : String(error) })
    return cred
  }
  try {
    return await mintKey(next, fetchFn)
  } catch (error) {
    log("console_mint_failed", { message: error instanceof Error ? error.message : String(error) })
    return next
  }
}
