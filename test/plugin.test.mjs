import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { test } from "node:test"
import plugin from "../src/index.ts"

test("registers a command login method on the anthropic integration", async () => {
  const updates = []
  const ctx = {
    integration: {
      transform: async (callback) => callback({ method: { update: (input) => updates.push(input) } }),
    },
  }

  await plugin.setup(ctx)

  assert.equal(plugin.id, "anthropic-console-login")
  assert.equal(updates.length, 1)
  const { integrationID, method } = updates[0]
  assert.equal(integrationID, "anthropic")
  assert.equal(method.type, "command")
  assert.equal(method.command[0], "node")
  assert.ok(existsSync(method.command[1]), "login script path must exist")
})
