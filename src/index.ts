import { Plugin } from "@opencode/plugin"
import { renewCredential, apiKeyOf, toCredential } from "./credentials.ts"
import { beginLogin } from "./oauth.ts"
import { registerConsoleRequests } from "./provider.ts"

export const INTEGRATION_ID = "anthropic"
export const METHOD_ID = "console"

export default Plugin.define({
  id: "anthropic-console-login",
  async setup(ctx) {
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { id: METHOD_ID, type: "oauth", label: "Anthropic Console (API usage billing)" },
        async authorize() {
          // OpenCode shows the URL; the callback server on the fixed port completes the flow.
          const { url, result } = await beginLogin({ openUrl: () => {}, log: () => {} })
          return {
            mode: "auto",
            url,
            instructions: "Sign in to the Anthropic Console in your browser.",
            callback: result.then(({ tokens, apiKey }) => toCredential(tokens, METHOD_ID, apiKey)),
          }
        },
        refresh: (credential) => renewCredential(credential),
        label(credential) {
          const key = apiKeyOf(credential)
          return key ? `Console key …${key.slice(-4)}` : undefined
        },
      })
    })
    await registerConsoleRequests(ctx)
  },
})
