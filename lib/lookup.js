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

async function postJson(url, payload, { token, signal, timeoutMs }) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-token": token,
        },
        body: JSON.stringify(payload),
        signal,
    });
    const rawText = await response.text();
    let data = null;
    let parsed = false;
    try {
        data = rawText ? JSON.parse(rawText) : null;
        parsed = true;
    } catch {
        parsed = false;
    }
    return { response, rawText, data, parsed };
}

/**
 * @param {string} mobile
 * @param {{endpoint?: string, token?: string, initData?: string, proxyUrl?: string,
 *          signal?: AbortSignal, timeoutMs?: number}} options
 *        `proxyUrl` is tried when the direct call is blocked by CORS.
 * @returns {Promise<{status: number, ok: boolean, ms: number, data: any, rawText: string, viaProxy: boolean}>}
 */
export async function checkMobile(mobile, options = {}) {
  const endpoint = String(options.endpoint || "").trim();
  const token = String(options.token || "").trim();
  const initData = options.initData ?? "";

  if (!endpoint) throw new LookupError("No lookup endpoint configured — set it in the Lookup tab.");
  if (!token) throw new LookupError("No lookup token configured — set it in the Lookup tab.");
  if (!isValidMobile(mobile)) {
    throw new LookupError("Enter a mobile number with 10–15 digits.");
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new LookupError("The endpoint in the Lookup tab is not a valid URL.");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new LookupError("The lookup endpoint must be http or https.");
  }

  const controller = options.signal ? null : new AbortController();
  const signal = options.signal || controller.signal;
  const timeoutMs = options.timeoutMs ?? 20000;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = performance.now();

  const payload = { mobile: normalizeMobile(mobile), token, initData };
  let result;
  let viaProxy = false;

  try {
    result = await postJson(url.toString(), payload, { token, signal, timeoutMs });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new LookupError(`Lookup timed out after ${Math.round(timeoutMs / 1000)}s.`, {});
    }
    // A browser CORS block surfaces as a TypeError. Retry through the
    // same-origin proxy when the page is served from a real origin.
    if (options.proxyUrl) {
      try {
        result = await postJson(
          options.proxyUrl,
          { endpoint: url.toString(), ...payload },
          { token, signal, timeoutMs },
        );
        viaProxy = true;
      } catch (proxyError) {
        throw new LookupError(
          proxyError?.name === "AbortError"
            ? "Lookup timed out."
            : `Lookup service unreachable — the direct call was blocked (no CORS headers) and the server proxy is unavailable. ${proxyError?.message || ""}`.trim(),
          { status: 0 },
        );
      }
    } else {
      throw new LookupError(
        "Network error — the lookup service could not be reached. If the host does not send CORS headers, the browser blocks the request; deploy the bundled /api/lookup proxy or serve the panel from the same origin.",
        { status: 0 },
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const { response, rawText, data, parsed } = result;
  const ms = Math.round(performance.now() - started);

  // Proxy responses wrap the upstream result.
  if (viaProxy) {
    const upstreamStatus = Number(response.headers.get("X-Upstream-Status")) || 0;
    if (!data || typeof data !== "object" || data.ok === undefined) {
      throw new LookupError(
        data?.error || `Lookup proxy returned HTTP ${response.status}.`,
        { status: response.status, body: data },
      );
    }
    if (!data.ok) {
      throw new LookupError(
        data.error || `Lookup failed with HTTP ${data.status || upstreamStatus || response.status}.`,
        { status: data.status || upstreamStatus || response.status, body: data.data ?? data },
      );
    }
    return {
      status: data.status || response.status,
      ok: true,
      ms,
      data: data.data,
      rawText: typeof data.data === "string" ? data.data : JSON.stringify(data.data),
      viaProxy: true,
    };
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
    viaProxy: false,
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
