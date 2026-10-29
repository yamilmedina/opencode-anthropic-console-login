// Pi prepends this block to the system prompt. Unlike Pi, omit cache_control:
// OpenCode already uses Anthropic's limit of 4 cache_control blocks.
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

export function withClaudeCodeIdentity(body: string): string {
  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return body
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return body
  const system = typeof payload.system === "string"
    ? [{ type: "text", text: payload.system }]
    : Array.isArray(payload.system) ? payload.system : []
  if (system[0]?.text === IDENTITY) return body
  payload.system = [{ type: "text", text: IDENTITY }, ...system]
  return JSON.stringify(payload)
}
