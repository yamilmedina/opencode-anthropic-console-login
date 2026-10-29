import { spawn } from "node:child_process"

// Keep OAuth on Node's fetch/TLS stack, as used by Pi. Secrets travel over stdin,
// never command-line arguments or logs. Model requests stay on OpenCode's transport.
const SCRIPT = `
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const { url, init } = JSON.parse(input);
  const response = await fetch(url, init);
  process.stdout.write(JSON.stringify({
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
    body: Buffer.from(await response.arrayBuffer()).toString("base64"),
  }));
} catch {
  process.exitCode = 1;
}
`

export const nodeFetch: typeof fetch = async (input, init) => {
  init?.signal?.throwIfAborted()
  if (input instanceof Request || (init?.body !== undefined && typeof init.body !== "string")) {
    throw new Error("Console OAuth transport requires a URL and a JSON string body")
  }
  const payload = JSON.stringify({
    url: String(input),
    init: { method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body },
  })

  return new Promise<Response>((resolve, reject) => {
    const child = spawn("node", ["--input-type=module", "-e", SCRIPT], { stdio: ["pipe", "pipe", "ignore"] })
    const chunks: Buffer[] = []
    let size = 0
    const abort = () => {
      child.kill()
      reject(init?.signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("Console OAuth request timed out after 60 seconds"))
    }, 60_000)
    timer.unref()
    init?.signal?.addEventListener("abort", abort, { once: true })
    if (init?.signal?.aborted) abort()
    child.on("error", () => reject(new Error("Cannot start Node.js for Console OAuth. Ensure Node.js 22.18+ is on PATH.")))
    child.stdin.on("error", () => {})
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_048_576) {
        child.kill()
        reject(new Error("Console OAuth response exceeded 1 MiB"))
      } else chunks.push(chunk)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      init?.signal?.removeEventListener("abort", abort)
      if (code !== 0) return reject(new Error("Node.js Console OAuth request failed before a response was received"))
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const body = [204, 205, 304].includes(result.status) ? null : Buffer.from(result.body, "base64")
        resolve(new Response(body, { status: result.status, statusText: result.statusText, headers: result.headers }))
      } catch {
        reject(new Error("Invalid response from Node.js Console OAuth transport"))
      }
    })
    child.stdin.end(payload)
  })
}

export const oauthFetch: typeof fetch = process.versions.bun ? nodeFetch : fetch
