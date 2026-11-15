/**
 * Tests for the same-origin lookup proxy (api/lookup.js).
 * Run with: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import handler from "../api/lookup.js";

function mockRes() {
    return {
        statusCode: 200,
        headers: {},
        body: "",
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(key, value) {
            this.headers[key.toLowerCase()] = value;
        },
        end(payload = "") {
            this.body = payload;
        },
        json() {
            return this.body ? JSON.parse(this.body) : null;
        },
    };
}

function req(body, { method = "POST", headers = {} } = {}) {
    return { method, body, headers };
}

const ALLOWED = "https://pricetrackerpro.fojadomain.fun/api/sw/check-mobile";

test("rejects non-POST methods", async () => {
    const res = mockRes();
    await handler(req(null, { method: "GET" }), res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.json().ok, false);
});

test("rejects a body that is not a JSON object", async () => {
    const res = mockRes();
    await handler(req("{not json"), res);
    assert.equal(res.statusCode, 400);

    const res2 = mockRes();
    await handler(req("[]"), res2);
    assert.equal(res2.statusCode, 400);
});

test("rejects endpoints on hosts outside the allow-list", async () => {
    const res = mockRes();
    await handler(
        req({ endpoint: "https://evil.example.com/api/sw/check-mobile", mobile: "9876543210", token: "t" }),
        res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /not allowed/);
});

test("rejects embedded credentials and non-http schemes", async () => {
    const res = mockRes();
    await handler(
        req({ endpoint: "https://user:pass@pricetrackerpro.fojadomain.fun/api/sw/x", mobile: "9876543210", token: "t" }),
        res,
    );
    assert.equal(res.statusCode, 400);

    const res2 = mockRes();
    await handler(req({ endpoint: "ftp://pricetrackerpro.fojadomain.fun/x", mobile: "9876543210", token: "t" }), res2);
    assert.equal(res2.statusCode, 400);
});

test("validates the mobile number and token before calling upstream", async () => {
    const res = mockRes();
    await handler(req({ endpoint: ALLOWED, mobile: "123", token: "t" }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /10–15 digits/);

    const res2 = mockRes();
    await handler(req({ endpoint: ALLOWED, mobile: "9876543210", token: "" }), res2);
    assert.equal(res2.statusCode, 400);
    assert.match(res2.json().error, /token/);
});

test("forwards an allowed request and wraps the upstream result", async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ status: "success", data: { name: "Test" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    try {
        const res = mockRes();
        await handler(req({ endpoint: ALLOWED, mobile: "+91 98765-43210", token: "secret" }), res);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, ALLOWED);
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.headers["x-token"], "secret");
        assert.deepEqual(JSON.parse(calls[0].init.body), {
            mobile: "919876543210",
            token: "secret",
            initData: "",
        });

        const payload = res.json();
        assert.equal(res.statusCode, 200);
        assert.equal(payload.ok, true);
        assert.equal(payload.status, 200);
        assert.equal(payload.data.data.name, "Test");
        assert.equal(res.headers["x-upstream-status"], "200");
    } finally {
        globalThis.fetch = original;
    }
});

test("reports an upstream HTTP error without throwing", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ message: "bad token" }), { status: 401 });

    try {
        const res = mockRes();
        await handler(req({ endpoint: ALLOWED, mobile: "9876543210", token: "t" }), res);
        const payload = res.json();
        assert.equal(payload.ok, false);
        assert.equal(payload.status, 401);
        assert.equal(payload.data.message, "bad token");
    } finally {
        globalThis.fetch = original;
    }
});

test("returns 502 when upstream is unreachable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new TypeError("fetch failed");
    };

    try {
        const res = mockRes();
        await handler(req({ endpoint: ALLOWED, mobile: "9876543210", token: "t" }), res);
        assert.equal(res.statusCode, 502);
        assert.match(res.json().error, /Upstream lookup failed/);
    } finally {
        globalThis.fetch = original;
    }
});
