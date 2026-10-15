/**
 * Typed, timeout-bounded HTTP.
 *
 * Ported in spirit from the team's PWA client, whose reasoning holds even more
 * strongly on a phone:
 *
 *   1. Every request has a hard timeout. A blind user holding up a phone cannot
 *      tell "thinking" from "hung". Hanging is the worst outcome; a fast, spoken
 *      failure is far better.
 *   2. Errors are typed and carry `retryable`, so the UI can turn one directly
 *      into a spoken question ("Should I try again?") instead of a generic error.
 *   3. Nothing here logs coordinates.
 */

export class ApiError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status ?? 0;
    this.code = opts.code ?? 'unknown';
    this.retryable = opts.retryable ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 10000;

function joinUrl(baseUrl, path) {
  const base = String(baseUrl).replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** fetch() with a hard timeout. Clears its timer so nothing leaks. */
export async function request(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ApiError('The request took too long.', { code: 'timeout', retryable: true });
    }
    throw new ApiError(error?.message ?? 'Network request failed.', {
      code: 'network',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parseError(response) {
  let code = `http_${response.status}`;
  let detail = `Request failed with status ${response.status}.`;
  let retryable = response.status >= 500 || response.status === 429;

  try {
    const body = await response.json();
    if (body?.error) code = typeof body.error === 'string' ? body.error : code;
    if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : detail;
    if (typeof body?.retryable === 'boolean') retryable = body.retryable;
  } catch {
    // Non-JSON body (a proxy page, say). Keep the defaults.
  }

  // 401 means the key is wrong, which retrying cannot fix.
  if (response.status === 401 || response.status === 403) retryable = false;

  return new ApiError(detail, { status: response.status, code, retryable });
}

export async function postJson(url, body, opts = {}) {
  const response = await request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
    },
    opts.timeoutMs
  );
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export async function getJson(url, opts = {}) {
  const response = await request(
    url,
    { method: 'GET', headers: { Accept: 'application/json', ...(opts.headers ?? {}) } },
    opts.timeoutMs
  );
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/** POST multipart/form-data. Never set Content-Type by hand: fetch adds the boundary. */
export async function postForm(url, form, opts = {}) {
  const response = await request(
    url,
    { method: 'POST', headers: { Accept: 'application/json', ...(opts.headers ?? {}) }, body: form },
    opts.timeoutMs
  );
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export { joinUrl, parseError };
