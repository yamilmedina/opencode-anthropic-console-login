import assert from "node:assert/strict"
import { test } from "node:test"
import { withClaudeCodeIdentity } from "../src/identity.ts"

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const block = { type: "text", text: IDENTITY }

test("prepends the identity block before an array system prompt", () => {
  const out = JSON.parse(withClaudeCodeIdentity(JSON.stringify({ system: [{ type: "text", text: "x" }], messages: [] })))
  assert.deepEqual(out.system, [block, { type: "text", text: "x" }])
})

test("converts a string system prompt and handles a missing one", () => {
  assert.deepEqual(JSON.parse(withClaudeCodeIdentity('{"system":"x"}')).system, [block, { type: "text", text: "x" }])
  assert.deepEqual(JSON.parse(withClaudeCodeIdentity('{"messages":[]}')).system, [block])
})

test("does not duplicate the identity and leaves non-JSON bodies alone", () => {
  const once = withClaudeCodeIdentity('{"system":"x"}')
  assert.equal(withClaudeCodeIdentity(once), once)
  assert.equal(withClaudeCodeIdentity("nope"), "nope")
})
