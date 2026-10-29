const DEBUG = process.env.CLAUDE_AUTH_DEBUG

function getLogPath(): string | null {
  if (!DEBUG) return null
  if (DEBUG === "1") return `${process.env.HOME}/.local/share/opencode/claude-auth-debug.log`
  return DEBUG
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (!DEBUG) return
  const logPath = getLogPath()
  if (!logPath) return

  try {
    const fs = require("node:fs")
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...data,
    })
    fs.appendFileSync(logPath, entry + "\n")
  } catch {
    // Ignore log failures
  }
}
