/**
 * Same-origin proxy for the mobile lookup endpoint.
 *
 * The browser cannot POST cross-origin to many lookup services because they do
 * not send CORS headers. This function forwards the request server-side so the
 * panel keeps working from the deployed domain.
 *
 * Safety rails:
 *  - POST only, JSON body, 8 KB limit
 *  - the upstream host must be on an allow-list (default: the panel's endpoint,
 *    extendable via LOOKUP_ALLOWED_HOSTS="host1,host2")
 *  - only http/https upstreams, no credentials in the URL, path must start "/"
 *  - the caller supplies their own token; nothing is stored server-side
 */

const DEFAULT_ALLOWED_HOSTS = ["pricetrackerpro.fojadomain.fun"];

function allowedHosts() {
    const extra = String(process.env.LOOKUP_ALLOWED_HOSTS || "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
}

function send(res, status, payload) {
    res.status(status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
    if (req.method === "OPTIONS") {
        res.setHeader("Allow", "POST, OPTIONS");
        res.status(204).end();
        return;
    }
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        send(res, 405, { ok: false, error: "Use POST." });
        return;
    }

    let body = req.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body || "{}");
        } catch {
            send(res, 400, { ok: false, error: "Body must be JSON." });
            return;
        }
    }
    if (!body || typeof body !== "object") {
        send(res, 400, { ok: false, error: "Body must be a JSON object." });
        return;
    }
    if (JSON.stringify(body).length > 8192) {
        send(res, 413, { ok: false, error: "Body too large." });
        return;
    }

    const rawUrl = String(body.endpoint || process.env.LOOKUP_ENDPOINT || "").trim();
    let upstream;
    try {
        upstream = new URL(rawUrl);
    } catch {
        send(res, 400, { ok: false, error: "A valid endpoint is required." });
        return;
    }
    if (!/^https?:$/.test(upstream.protocol)) {
        send(res, 400, { ok: false, error: "Endpoint must be http or https." });
        return;
    }
    if (upstream.username || upstream.password) {
        send(res, 400, { ok: false, error: "Endpoint must not embed credentials." });
        return;
    }
    if (!allowedHosts().has(upstream.hostname.toLowerCase())) {
        send(res, 403, {
            ok: false,
            error: `Host "${upstream.hostname}" is not allowed. Add it to LOOKUP_ALLOWED_HOSTS.`,
        });
        return;
    }
    if (!upstream.pathname.startsWith("/")) {
        send(res, 400, { ok: false, error: "Endpoint path must be absolute." });
        return;
    }

    const mobile = String(body.mobile ?? "").replace(/[^\d]/g, "");
    const token = String(body.token ?? req.headers["x-token"] ?? "").trim();
    const initData = body.initData ?? "";

    if (mobile.length < 10 || mobile.length > 15) {
        send(res, 400, { ok: false, error: "Enter a mobile number with 10–15 digits." });
        return;
    }
    if (!token) {
        send(res, 400, { ok: false, error: "A token is required." });
        return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const started = Date.now();

    try {
        const response = await fetch(upstream.toString(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-token": token,
            },
            body: JSON.stringify({ mobile, token, initData }),
            signal: controller.signal,
        });

        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = text;
        }

        res.setHeader("X-Upstream-Status", String(response.status));
        res.setHeader("X-Upstream-Ms", String(Date.now() - started));
        send(res, 200, { ok: response.ok, status: response.status, data });
    } catch (error) {
        send(res, 502, {
            ok: false,
            error:
                error?.name === "AbortError"
                    ? "Upstream lookup timed out."
                    : `Upstream lookup failed: ${error?.message || "network error"}`,
        });
    } finally {
        clearTimeout(timer);
    }
}
