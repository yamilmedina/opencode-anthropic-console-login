import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { spawnSync } from "node:child_process"

test("debug logging writes rate-limit diagnostics in ESM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "console-plugin-log-"))
  try {
    const path = join(directory, "debug.jsonl")
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      'import { log } from "./src/logger.ts"; log("fetch_rate_limited", { status: 429, delayMs: 5000 })',
    ], { cwd: process.cwd(), env: { ...process.env, CONSOLE_LOGIN_DEBUG: path }, encoding: "utf8" })
    assert.equal(child.status, 0, child.stderr)
    const entry = JSON.parse(await readFile(path, "utf8"))
    assert.equal(entry.event, "fetch_rate_limited")
    assert.equal(entry.status, 429)
    assert.equal(entry.delayMs, 5000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
