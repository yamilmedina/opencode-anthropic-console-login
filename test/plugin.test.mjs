import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../src/index.ts"

test("registers an OAuth method on the anthropic integration", async () => {
  const updates = []
  const hooks = []
  const ctx = {
    session: { hook: async (name, cb, opts) => hooks.push({ name, opts }) },
    integration: {
      transform: async (callback) => callback({ method: { update: (input) => updates.push(input) } }),
    },
  }

  await plugin.setup(ctx)

  assert.deepEqual(hooks, [
    { name: "http.request", opts: { providerID: "anthropic" } },
    { name: "http.response", opts: { providerID: "anthropic" } },
  ])

  assert.equal(plugin.id, "anthropic-console-login")
  assert.equal(updates.length, 1)
  const { integrationID, method, authorize, refresh, label } = updates[0]
  assert.equal(integrationID, "anthropic")
  assert.equal(method.type, "oauth")
  assert.equal(method.id, "console")
  assert.equal(method.label, "Anthropic Console (API usage billing)")
  assert.ok(!("command" in method))
  assert.equal(typeof authorize, "function")
  assert.equal(typeof refresh, "function")
  assert.equal(typeof label, "function")

  const cred = { type: "oauth", methodID: "console", access: "a", refresh: "r", expires: 1, metadata: { apiKey: "sk-ant-abcd1234" } }
  assert.equal(label(cred), "Console key …1234")
  assert.equal(label({ ...cred, metadata: undefined }), undefined)
})
