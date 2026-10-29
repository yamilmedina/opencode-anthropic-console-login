import { fetchWithRetry } from "./http.ts"
import { buildRequestHeaders } from "./model-config.ts"
import { log } from "./logger.ts"

function modelFromBody(body: string): string {
  try {
    return (JSON.parse(body) as { model?: string }).model ?? "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Prepare the request with proper headers and retry logic.
 * The OpenCode provider sends requests with x-api-key, but Anthropic Console
 * API expects Authorization: Bearer with the API key.
 */
export async function prepareConsoleRequest(
  request: Request,
  apiKey: string,
): Promise<Request> {
  const body = await request.clone().text()
  const modelID = modelFromBody(body)
  
  const headers = new Headers(request.headers)
  headers.delete("x-api-key")
  
  const newHeaders = buildRequestHeaders(apiKey, modelID)
  for (const [key, value] of Object.entries(newHeaders)) {
    headers.set(key, value)
  }

  return new Request(request, { headers })
}

/**
 * Send request with retry on 429/529 rate limits.
 */
export async function sendWithRetry(
  request: Request,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  return fetchWithRetry(
    request.url,
    {
      method: request.method,
      headers: request.headers,
      body: await request.clone().text(),
      signal: request.signal,
    },
    3,
    fetchFn,
  )
}

/**
 * Handle response errors and log them.
 */
export async function handleResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  const body = await request.clone().text()
  const modelID = modelFromBody(body)
  
  if (!response.ok) {
    log("fetch_error_response", {
      status: response.status,
      modelID,
      headers: Object.fromEntries(response.headers),
    })
  }
  
  return response
}
