#!/usr/bin/env node
// Run by OpenCode's /connect. Only the API key goes to stdout; progress goes to stderr.
import { login } from "./oauth.mjs"

try {
  process.stdout.write(await login())
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
