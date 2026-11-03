// Prepend the identity without adding cache_control. Preserve existing cache markers.
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
