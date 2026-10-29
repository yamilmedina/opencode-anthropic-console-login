import { randomUUID } from "node:crypto"

const VERSION = "1.0.0"

export function getUserAgent(): string {
  return process.env.ANTHROPIC_USER_AGENT ?? `opencode-anthropic-console-login/${VERSION}`
}

export function buildRequestHeaders(): Record<string, string> {
  const sessionId = randomUUID()
  return {
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": getUserAgent(),
    "x-client-request-id": randomUUID(),
    "x-claude-code-session-id": sessionId,
    "x-app": "opencode",
  }
}
