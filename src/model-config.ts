export function buildRequestHeaders(): Record<string, string> {
  return {
    "anthropic-version": "2023-06-01",
    "user-agent": "opencode-anthropic-console-login",
  }
}
