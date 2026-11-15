/**
 * Mobile-number lookup client for the `check-mobile` endpoint.
 *
 * The request shape mirrors the service's documented contract:
 *
 *   POST <endpoint>
 *   Content-Type: application/json
 *   x-token: <token>
 *   { "mobile": "<number>", "token": "<token>", "initData": "" }
 *
 * Both the endpoint and the token are configured in the UI and stored in this
 * browser only — no credential is compiled into the bundle.
 */

export const DEFAULT_LOOKUP_ENDPOINT =
  "https://pricetrackerpro.fojadomain.fun/api/sw/check-mobile";

export class LookupError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "LookupError";
    this.status = status;
    this.body = body;
  }
}

/** Keep digits only; a leading `+` is allowed and stripped. */
export function normalizeMobile(input) {
  const raw = String(input ?? "").trim();
  const digits = raw.replace(/[^\d]/g, "");
  return digits;
}

/** 10–15 digits covers local and E.164-length numbers. */
export function isValidMobile(input) {
  const digits = normalizeMobile(input);
  return digits.length >= 10 && digits.length <= 15;
}

/**
 * @param {string} mobile
 * @param {{endpoint?: string, token?: string, initData?: string, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{status: number, ok: boolean, ms: number, data: any, rawText: string}>}
 */
export async function checkMobile(mobile, options = {}) {
  const endpoint = String(options.endpoint || "").trim();
  const token = String(options.token || "").trim();
  const initData = options.initData ?? "";

  if (!endpoint) throw new LookupError("No lookup endpoint configured.");
  if (!token) throw new LookupError("No lookup token configured.");
  if (!isValidMobile(mobile)) {
    throw new LookupError("Enter a mobile number with 10–15 digits.");
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new LookupError("The lookup endpoint is not a valid URL.");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new LookupError("The lookup endpoint must be http or https.");
  }

  const controller = options.signal ? null : new AbortController();
  const signal = options.signal || controller.signal;
  const timeoutMs = options.timeoutMs ?? 20000;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = performance.now();

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-token": token,
      },
      body: JSON.stringify({
        mobile: normalizeMobile(mobile),
        token,
        initData,
      }),
      signal,
    });
  } catch (error) {
    throw new LookupError(
      error?.name === "AbortError"
        ? `Lookup timed out after ${Math.round(timeoutMs / 1000)}s.`
        : "Network error — the lookup service could not be reached. If the host does not send CORS headers, the browser blocks the request; call it from the same origin or your own server instead.",
      { status: 0 },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const rawText = await response.text();
  const ms = Math.round(performance.now() - started);

  let data = null;
  let parsed = false;
  try {
    data = rawText ? JSON.parse(rawText) : null;
    parsed = true;
  } catch {
    parsed = false;
  }

  if (!response.ok) {
    throw new LookupError(
      `Lookup failed with HTTP ${response.status}${parsed && data?.message ? `: ${data.message}` : ""}`,
      { status: response.status, body: parsed ? data : rawText },
    );
  }

  return {
    status: response.status,
    ok: true,
    ms,
    data: parsed ? data : rawText,
    rawText,
  };
}

/** Flatten a lookup payload for the key/value result table. */
export function flattenResult(value, prefix = "", out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => flattenResult(entry, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (entry && typeof entry === "object") flattenResult(entry, path, out);
      else out.push([path, entry]);
    }
    return out;
  }
  out.push([prefix || "value", value]);
  return out;
}
