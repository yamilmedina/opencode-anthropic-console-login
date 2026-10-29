/*
 * Hook verification (@opencode/plugin 2.2.1, dist/promise/aisdk.d.ts):
 *   AISDKHooks.sdk = { readonly model: Model.Info; readonly package: string;
 *                      readonly options: Record<string, any>; sdk?: any }
 *   AISDKDomain.hook: ModelHooks<AISDKHooks>, accepts { providerID } to scope the hook.
 * `options` is a mutable record handed to the AI SDK provider factory, so setting
 * `options.fetch` is the supported way to carry a custom fetch. The installed packages are
 * types only, so that the factory honours `fetch` could not be checked at runtime.
 * Persistence: the plugin context exposes only `credential.activate`; there is no API to save a
 * refreshed credential. The refreshed credential is kept in memory for the process, and a failed
 * refresh is reported through `integration.connection.status` ("needs_auth").
 */
import type { Context } from "@opencode/plugin"
import { apiKeyOf, isExpiring, mintKey, refreshCredential, type OAuthCredential } from "./credentials.ts"
import { describeRateLimit, fetchWithRetry } from "./http.ts"
import { log } from "./logger.ts"
import { buildRequestHeaders } from "./model-config.ts"
import { INTEGRATION_ID, METHOD_ID } from "./index.ts"

function requestHeaders(input: RequestInfo | URL, init: RequestInit | undefined, apiKey: string): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  headers.delete("authorization")
  for (const [key, value] of Object.entries(buildRequestHeaders())) headers.set(key, value)
  headers.set("x-api-key", apiKey)
  return headers
}

export function createConsoleFetch(
  getCredential: () => Promise<OAuthCredential | undefined>,
  save: (credential: OAuthCredential) => Promise<void>,
  base: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    let cred = await getCredential()
    if (!cred) return base(input, init)

    // Refresh also re-mints; otherwise mint only when the credential carries no key.
    if (isExpiring(cred)) {
      cred = await refreshCredential(cred, base)
      await save(cred)
    } else if (!apiKeyOf(cred)) {
      cred = await mintKey(cred, base)
      await save(cred)
    }

    const send = (key: string) =>
      fetchWithRetry(input, { ...init, headers: requestHeaders(input, init, key) }, 3, base)

    let res = await send(apiKeyOf(cred)!)

    // A stream body cannot be replayed, so it is never retried after a 401.
    if (res.status === 401 && !(init?.body instanceof ReadableStream)) {
      cred = await mintKey(cred, base)
      await save(cred)
      res = await send(apiKeyOf(cred)!)
    }

    if (res.status === 429) log("fetch_rate_limited_final", { message: describeRateLimit(res) })
    return res
  }
}

export async function registerConsoleRequests(ctx: Pick<Context, "aisdk" | "integration">): Promise<void> {
  // The store keeps returning the original credential, so remember the refreshed one until the user reconnects.
  let origin: OAuthCredential | undefined
  let current: OAuthCredential | undefined

  const getCredential = async () => {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    if (!connection) return undefined
    const stored = await ctx.integration.connection.resolve(connection)
    if (stored?.type !== "oauth" || stored.methodID !== METHOD_ID) return undefined
    if (!origin || origin.access !== stored.access || origin.refresh !== stored.refresh) {
      origin = stored as OAuthCredential
      current = origin
    }
    return current
  }
  const save = async (credential: OAuthCredential) => {
    current = credential
  }

  await ctx.aisdk.hook(
    "sdk",
    ({ options }) => {
      const consoleFetch = createConsoleFetch(getCredential, save, options.fetch ?? fetch)
      options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          return await consoleFetch(input, init)
        } catch (error) {
          if (error instanceof Error && error.message.includes("sign in again")) {
            const connection = await ctx.integration.connection.active(INTEGRATION_ID)
            if (connection) {
              await ctx.integration.connection.status({
                integrationID: INTEGRATION_ID,
                connection,
                status: { status: "needs_auth", message: error.message },
              })
            }
          }
          throw error
        }
      }
    },
    { providerID: INTEGRATION_ID },
  )
}
