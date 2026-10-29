import { createApiKey } from "./oauth.ts"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

export interface OAuthCredential {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  oauthTokenCreatedAt?: number
  _cachedApiKey?: string
  _lastApiKeyCreatedAt?: number
}

/**
 * Check if an OAuth token has consumed 95% or more of its lifetime.
 * Returns false if no expiry information is available.
 */
export function isOAuthTokenExpired(credential: OAuthCredential): boolean {
  if (!credential.expiresAt || !credential.oauthTokenCreatedAt) {
    return false
  }
  
  const totalLifetime = credential.expiresAt - credential.oauthTokenCreatedAt
  const elapsed = Date.now() - credential.oauthTokenCreatedAt
  const percentConsumed = elapsed / totalLifetime
  
  return percentConsumed >= 0.95
}

/**
 * Get or create an API key. Reuses cached key if less than 1 hour old,
 * otherwise creates a new one.
 */
export async function getOrCreateApiKey(
  credential: OAuthCredential,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const now = Date.now()
  const ONE_HOUR_MS = 60 * 60 * 1000
  
  // Reuse cached key if it exists and is less than 1 hour old
  if (
    credential._cachedApiKey &&
    credential._lastApiKeyCreatedAt &&
    now - credential._lastApiKeyCreatedAt < ONE_HOUR_MS
  ) {
    return credential._cachedApiKey
  }
  
  // Create a new API key
  const newKey = await createApiKey(credential.accessToken, fetchFn)
  
  // Cache it
  credential._cachedApiKey = newKey
  credential._lastApiKeyCreatedAt = now
  
  return newKey
}

/**
 * Refresh an OAuth token using a refresh token.
 * Returns a new OAuthCredential with the new access token and expiry information.
 */
export async function refreshOAuthToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch
): Promise<OAuthCredential> {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${await response.text()}`)
  }
  
  const data = await response.json()
  const now = Date.now()
  const expiresInSeconds = data.expires_in ?? 3600
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + expiresInSeconds * 1000,
    oauthTokenCreatedAt: now,
  }
}

/**
 * Validate that a value is a valid OAuthCredential.
 * Returns the credential if valid, null otherwise.
 */
export function validateCredentialFormat(value: unknown): OAuthCredential | null {
  if (!value || typeof value !== "object") {
    return null
  }
  
  const obj = value as Record<string, unknown>
  
  if (typeof obj.accessToken !== "string") {
    return null
  }
  
  return value as OAuthCredential
}
