import { appendFileSync } from "node:fs"

function getLogPath(): string | null {
  const DEBUG = process.env.CONSOLE_LOGIN_DEBUG
  if (!DEBUG || DEBUG === "0") return null
  if (DEBUG === "1") return `${process.env.HOME}/.local/share/opencode/console-login-debug.log`
  return DEBUG
}

export function log(event: string, data?: Record<string, unknown>): void {
  const logPath = getLogPath()
  if (!logPath) return

  try {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...data,
    })
    appendFileSync(logPath, entry + "\n")
  } catch {
    // Ignore log failures
  }
}
