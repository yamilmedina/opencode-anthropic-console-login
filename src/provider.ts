import { oauthFetch } from "./oauth-transport.ts"
import type { Plugin } from "@opencode/plugin"
import { apiKeyOf, mintKey, type OAuthCredential } from "./credentials.ts"
import { buildRequestHeaders } from "./model-config.ts"
import { withClaudeCodeIdentity } from "./identity.ts"
import { log } from "./logger.ts"
import { INTEGRATION_ID, METHOD_ID } from "./index.ts"

type Connection = NonNullable<Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>>

/** A key minted after the stored one was rejected. OpenCode can only persist keys through the method's refresh. */
type Replacement = { replaces: string | undefined; key: string }

/**
 * OpenCode 2 refreshes OAuth tokens and stores the result before `resolve` returns (see
 * `renewCredential`). This hook only sets the key, and mints a replacement after a 401.
 */
export async function registerConsoleRequests(
  ctx: Pick<Plugin.Context, "session" | "integration">,
  fetchFn: typeof fetch = oauthFetch,
): Promise<void> {
  const replacements = new Map<string, Replacement>()
  const minting = new Map<string, Promise<string>>()
  const rejected = new Set<string>()
  const requests = new WeakMap<Request, string>()

  async function active(): Promise<{ connection: Connection; credential: OAuthCredential } | undefined> {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    if (connection?.type !== "credential") return undefined
    const stored = await ctx.integration.connection.resolve(connection)
    if (stored?.type !== "oauth" || stored.methodID !== METHOD_ID) return undefined
    return { connection, credential: stored as OAuthCredential }
  }

  function currentKey(id: string, credential: OAuthCredential): string | undefined {
    const stored = apiKeyOf(credential)
    const replacement = replacements.get(id)
    const key = replacement && replacement.replaces === stored ? replacement.key : stored
    return key && !rejected.has(key) ? key : undefined
  }

  async function prepare(): Promise<string | undefined> {
    const found = await active()
    if (!found) return undefined
    const { connection, credential } = found
    let key = currentKey(connection.id, credential)
    if (!key) {
      let pending = minting.get(connection.id)
      if (!pending) {
        pending = mintKey(credential, fetchFn).then((next) => {
          const minted = apiKeyOf(next)!
          replacements.set(connection.id, { replaces: apiKeyOf(credential), key: minted })
          return minted
        }).finally(() => minting.delete(connection.id))
        minting.set(connection.id, pending)
      }
      key = await pending
    }
    // The user may have switched accounts while waiting; never use the old account's key.
    const latest = await ctx.integration.connection.active(INTEGRATION_ID)
    return latest?.id === connection.id ? key : prepare()
  }

  await ctx.session.hook("http.request", async (event) => {
    if (event.model.providerID !== INTEGRATION_ID || new URL(event.request.url).origin !== "https://api.anthropic.com") return
    event.request.signal.throwIfAborted()
    const key = await prepare()
    event.request.signal.throwIfAborted()
    if (!key) return

    const headers = new Headers(event.request.headers)
    headers.delete("authorization")
    for (const [name, value] of Object.entries(buildRequestHeaders())) {
      if (!headers.has(name)) headers.set(name, value)
    }
    headers.set("x-api-key", key)
    if (event.request.method === "POST" && new URL(event.request.url).pathname === "/v1/messages" && event.request.body) {
      const body = withClaudeCodeIdentity(await event.request.clone().text())
      headers.delete("content-length")
      event.request = new Request(event.request.url, { method: "POST", headers, body, signal: event.request.signal })
    } else {
      event.request = new Request(event.request, { headers })
    }
    requests.set(event.request, key)
  }, { providerID: INTEGRATION_ID })

  await ctx.session.hook("http.response", (event) => {
    const key = requests.get(event.request)
    if (!key) return
    requests.delete(event.request)
    if (event.response.status === 429 || event.response.status === 529) {
      log("console_rate_limited", {
        status: event.response.status,
        retryAfter: event.response.headers.get("retry-after"),
        requestId: event.response.headers.get("request-id"),
      })
    }
    // The host owns retries. A 401 rejects this key for the next request without replaying a stream.
    if (event.response.status === 401) rejected.add(key)
  }, { providerID: INTEGRATION_ID })
}
