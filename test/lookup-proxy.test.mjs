/**
 * Client-side fallback to the same-origin proxy when CORS blocks the direct call.
 * Run with: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    checkMobile,
    isValidMobile,
    LookupError,
    normalizeMobile,
} from "../lib/lookup.js";

const ENDPOINT = "https://pricetrackerpro.fojadomain.fun/api/sw/check-mobile";

test("normalizes Indian dialing prefixes and validates exactly 10 mobile digits", () => {
    for (const input of [
        "9876543210",
        "+91 98765-43210",
        "91 98765 43210",
        "09876543210",
        "0 91 98765 43210",
    ]) {
        assert.equal(normalizeMobile(input), "9876543210");
        assert.equal(isValidMobile(input), true);
    }
    for (const input of ["1234567890", "987654321", "9198765432100", "abc"]) {
        assert.equal(isValidMobile(input), false);
    }
});

test("falls back to the proxy when the direct call is blocked", async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url) === ENDPOINT) throw new TypeError("Failed to fetch");
        return new Response(
            JSON.stringify({ ok: true, status: 200, data: { data: { name: "Proxied" } } }),
            { status: 200, headers: { "X-Upstream-Status": "200" } },
        );
    };

    try {
        const result = await checkMobile("9876543210", {
            endpoint: ENDPOINT,
            token: "tok",
            proxyUrl: "https://panel.example.com/api/lookup",
        });

        assert.equal(calls.length, 2);
        assert.equal(calls[1].url, "https://panel.example.com/api/lookup");
        const forwarded = JSON.parse(calls[1].init.body);
        assert.equal(forwarded.endpoint, ENDPOINT);
        assert.equal(forwarded.mobile, "9876543210");
        assert.equal(forwarded.token, "tok");
        assert.equal(calls[1].init.headers["x-token"], "tok");

        assert.equal(result.viaProxy, true);
        assert.equal(result.status, 200);
        assert.equal(result.data.data.name, "Proxied");
    } finally {
        globalThis.fetch = original;
    }
});

test("reports the proxy's own error instead of a generic CORS message", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url) === ENDPOINT) throw new TypeError("Failed to fetch");
        return new Response(
            JSON.stringify({ ok: false, error: 'Host "x.example" is not allowed.' }),
            { status: 403 },
        );
    };

    try {
        await assert.rejects(
            () =>
                checkMobile("9876543210", {
                    endpoint: ENDPOINT,
                    token: "tok",
                    proxyUrl: "https://panel.example.com/api/lookup",
                }),
            (error) => {
                assert.ok(error instanceof LookupError);
                assert.match(error.message, /not allowed/);
                return true;
            },
        );
    } finally {
        globalThis.fetch = original;
    }
});

test("explains the CORS situation when no proxy is configured", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new TypeError("Failed to fetch");
    };

    try {
        await assert.rejects(
            () => checkMobile("9876543210", { endpoint: ENDPOINT, token: "tok" }),
            (error) => {
                assert.match(error.message, /CORS|proxy/i);
                return true;
            },
        );
    } finally {
        globalThis.fetch = original;
    }
});

test("a direct success never touches the proxy", async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    };

    try {
        const result = await checkMobile("9876543210", {
            endpoint: ENDPOINT,
            token: "tok",
            proxyUrl: "https://panel.example.com/api/lookup",
        });
        assert.deepEqual(calls, [ENDPOINT]);
        assert.equal(result.viaProxy, false);
    } finally {
        globalThis.fetch = original;
    }
});
