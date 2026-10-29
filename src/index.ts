import { fileURLToPath } from "node:url"
import { Plugin, Provider } from "@opencode/plugin"
import { fetchWithRetry } from "./http.ts"

export const INTEGRATION_ID = "anthropic"
export const METHOD_ID = "console"

const PROVIDER_ID = Provider.ID.make("anthropic")

export default Plugin.define({
  id: "anthropic-console-login",
  async setup(ctx) {
    const script = fileURLToPath(new URL("./login.mjs", import.meta.url))
    
    // Register the command auth method
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: "command",
          label: "Anthropic Console (API usage billing)",
          command: ["node", script],
        },
      })
    })

    // Wrap the Anthropic provider to add retry logic for Console API keys
    if (ctx.provider) {
      await ctx.provider.transform(async (editor) => {
        if (editor.id !== PROVIDER_ID) return

        const originalFetch = editor.fetch
        if (!originalFetch) return

        // Wrap fetch with retry logic
        editor.fetch = async (input, init) => {
          return fetchWithRetry(input, init, 3, originalFetch)
        }
      })
    }
  },
})
