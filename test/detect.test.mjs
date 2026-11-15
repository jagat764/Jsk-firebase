/**
 * Unit tests for the pure helpers and the lookup client.
 * Run with: npm test   (node --test)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    buildCandidatePaths,
    deviceIdFromMessage,
    databaseLabel,
    deviceFieldScore,
    deviceMatches,
    extractSims,
    formatBytes,
    isDeadValue,
    isPingOnly,
    messageMatches,
    normalizeDatabaseUrl,
    normalizeDevice,
    normalizeMessage,
    normalizeStatus,
    objectEntries,
    parseDatabaseUrl,
    parseInfoBlob,
    parseTimestamp,
    relativeTime,
    restUrl,
    sortByTimeDesc,
} from "../lib/detect.js";

import { normalizeMobile, isValidMobile, checkMobile, flattenResult } from "../lib/lookup.js";

/* ------------------------------- URLs -------------------------------- */

test("parseDatabaseUrl accepts bare hosts, full URLs and auth params", () => {
    assert.deepEqual(parseDatabaseUrl("my-proj-default-rtdb.firebaseio.com"), {
        base: "https://my-proj-default-rtdb.firebaseio.com",
        auth: "",
    });
    assert.deepEqual(parseDatabaseUrl("https://x.firebaseio.com/"), {
        base: "https://x.firebaseio.com",
        auth: "",
    });
    assert.deepEqual(parseDatabaseUrl("https://x.firebaseio.com/?auth=abc123"), {
        base: "https://x.firebaseio.com",
        auth: "abc123",
    });
    assert.deepEqual(parseDatabaseUrl("http://localhost:9000"), null);
    assert.deepEqual(parseDatabaseUrl("not a url"), null);
    assert.deepEqual(parseDatabaseUrl("ftp://x.firebaseio.com"), null);
    assert.deepEqual(parseDatabaseUrl(""), null);
});

test("normalizeDatabaseUrl round-trips and keeps the secret encoded", () => {
    assert.equal(
        normalizeDatabaseUrl("x.firebaseio.com"),
        "https://x.firebaseio.com",
    );
    assert.equal(
        normalizeDatabaseUrl("https://x.firebaseio.com?auth=a b/c"),
        "https://x.firebaseio.com?auth=a%20b%2Fc",
    );
    assert.equal(normalizeDatabaseUrl(""), "");
    assert.equal(databaseLabel("https://x.firebaseio.com"), "x.firebaseio.com");
    assert.equal(databaseLabel(""), "not connected");
});

test("restUrl builds node URLs and skips empty params", () => {
    assert.equal(restUrl("https://x.firebaseio.com", ""), "https://x.firebaseio.com/.json");
    assert.equal(
        restUrl("https://x.firebaseio.com/", "/clients/"),
        "https://x.firebaseio.com/clients.json",
    );
    assert.equal(
        restUrl("https://x.firebaseio.com", "user_sms/abc", { shallow: true, auth: "" }),
        "https://x.firebaseio.com/user_sms/abc.json?shallow=true",
    );
    assert.equal(
        restUrl("https://x.firebaseio.com", "messages", { limitToLast: 50, auth: "t" }),
        "https://x.firebaseio.com/messages.json?limitToLast=50&auth=t",
    );
});

/* ---------------------------- detection ------------------------------ */

test("candidate paths prefer user_data over the ping decoys", () => {
    const paths = buildCandidatePaths([
        "clients", "devices", "user_data", "user_sms", "user_list",
        "sms_forward", "guard", "licenses", "_comments",
    ]);
    assert.equal(paths[0], "user_data");
    assert.ok(paths.includes("clients"));
    assert.ok(paths.includes("devices"));
    assert.ok(!paths.includes("user_sms"));
    assert.ok(!paths.includes("sms_forward"));
    assert.ok(!paths.includes("guard"));
    assert.ok(!paths.includes("licenses"));
});

test("candidate paths resolve nested All_User containers first", () => {
    const paths = buildCandidatePaths(
        ["All_User", "messages", "Commands"],
        { All_User: ["Info", "Data", "unrelated"] },
    );
    assert.deepEqual(paths.slice(0, 2), ["All_User/Info", "All_User/Data"]);
    assert.ok(!paths.includes("All_User"));
    assert.ok(!paths.includes("messages"));
});

test("candidate paths fall back to unknown root nodes", () => {
    const paths = buildCandidatePaths(["weird_node", "messages"]);
    assert.deepEqual(paths, ["weird_node"]);
});

test("ping-only nodes are detected and scored as non-devices", () => {
    const pingRecords = [
        { ping: { ts: 1700000000000, wake: true } },
        { ping: { ts: 1700000001000, wake: false } },
    ];
    assert.equal(isPingOnly(pingRecords), true);
    assert.equal(isPingOnly([{ ping: 1, battery: 50 }]), false);
    assert.equal(isPingOnly([]), false);
    assert.equal(deviceFieldScore({ ping: { ts: 1 } }), 0);
    assert.equal(deviceFieldScore({ battery: 80, status: "online" }), 2);
    assert.equal(deviceFieldScore(null), 0);
    assert.equal(deviceFieldScore([1, 2]), 0);
});

test("objectEntries keeps only plain-object records", () => {
    const entries = objectEntries({ a: { x: 1 }, b: 5, c: null, d: [1] });
    assert.deepEqual(entries.map(([key]) => key), ["a"]);
    assert.deepEqual(objectEntries(null), []);
});

/* --------------------------- normalisation --------------------------- */

test("parseInfoBlob reads Device_info blobs", () => {
    assert.deepEqual(parseInfoBlob("Model: Pixel 6\nOS Version: 13"), {
        model: "Pixel 6",
        "os version": "13",
    });
    assert.deepEqual(parseInfoBlob("Model: A | Android: 11"), { model: "A", android: "11" });
    assert.deepEqual(parseInfoBlob("garbage"), {});
    assert.deepEqual(parseInfoBlob(null), {});
});

test("parseTimestamp handles seconds, milliseconds, ISO and d/m/Y", () => {
    assert.equal(parseTimestamp(1700000000), 1700000000000);
    assert.equal(parseTimestamp(1700000000000), 1700000000000);
    assert.equal(parseTimestamp("1700000000"), 1700000000000);
    assert.equal(parseTimestamp("2023-11-14T22:13:20Z"), 1700000000000);
    assert.equal(parseTimestamp("2023-11-14 22:13:20"), 1700000000000);
    assert.equal(parseTimestamp("14/11/2023 22:13:20"), 1700000000000);
    assert.equal(parseTimestamp(0), null);
    assert.equal(parseTimestamp(""), null);
    assert.equal(parseTimestamp("Unknown"), null);
    assert.equal(parseTimestamp(null), null);
});

test("normalizeStatus maps strings and booleans", () => {
    assert.equal(normalizeStatus("online"), "online");
    assert.equal(normalizeStatus("ONLINE"), "online");
    assert.equal(normalizeStatus(true), "online");
    assert.equal(normalizeStatus("offline"), "offline");
    assert.equal(normalizeStatus(false), "offline");
    assert.equal(normalizeStatus("weird"), "unknown");
    assert.equal(normalizeStatus(undefined), "unknown");
});

test("dead SIM placeholders are dropped", () => {
    for (const value of ["No SIM Found", "No Data", "Not Available", "Unknown", "", null, 0]) {
        assert.equal(isDeadValue(value), true, `expected ${String(value)} to be dead`);
    }
    assert.equal(isDeadValue("9876543210"), false);
});

test("normalizeDevice handles the inline-SIM layout", () => {
    const device = normalizeDevice(
        {
            d_name: "Redmi Note 12",
            battery: "87%",
            status: "online",
            numberSim1: "9876543210",
            nameSim1: "Jio",
            typeSim1: "4G",
            iccIdSim1: "8991000000000000001",
            numberSim2: "No SIM Found",
            nameSim2: "No Data",
            installTime: 1690000000000,
            TimeandDate: "14/11/2023 22:13:20",
            Device_info: "Model: Redmi Note 12\nOS Version: 13",
        },
        "dev-1",
    );

    assert.equal(device.id, "dev-1");
    assert.equal(device.modelName, "Redmi Note 12");
    assert.equal(device.battery, 87);
    assert.equal(device.status, "online");
    assert.equal(device.phoneNumber, "9876543210");
    assert.equal(device.dualSim, false);
    assert.equal(device.sims.length, 1);
    assert.equal(device.sims[0].carrier, "Jio");
    assert.equal(device.sims[0].iccid, "8991000000000000001");
    assert.equal(device.sims[0].type, "4G");
    assert.equal(device.androidV, "13");
    assert.equal(device.joined, 1690000000000);
    assert.equal(device.lastSeen, Date.UTC(2023, 10, 14, 22, 13, 20));
});

test("normalizeDevice infers dual SIM and parses sidecar SIM maps", () => {
    const device = normalizeDevice(
        {
            device_name: "Galaxy A14",
            status: "offline",
            sims: {
                sim1: { phoneNumber: "9000000001", carrierName: "Airtel" },
                sim2: { phoneNumber: "9000000002", carrierName: "Vi" },
            },
        },
        "dev-2",
    );
    assert.equal(device.dualSim, true);
    assert.equal(device.sims.length, 2);
    assert.equal(device.operator, "Airtel");
    assert.equal(device.battery, null);
    assert.equal(device.lastSeen, null);
});

test("normalizeDevice handles the RTX layout", () => {
    const device = normalizeDevice(
        {
            device_name: "RTX-1",
            charge: "42",
            Sim1: { phoneNumber: "9111111111", carrierName: "Jio" },
            Sim2: "9122222222",
        },
        "rtx",
    );
    assert.equal(device.battery, 42);
    assert.equal(device.sims.length, 2);
    assert.equal(device.phoneNumber, "9111111111");
});

test("extractSims tolerates missing and malformed input", () => {
    assert.deepEqual(extractSims({}), []);
    assert.deepEqual(extractSims(null), []);
    assert.deepEqual(extractSims({ numberSim1: "No SIM Found" }), []);
    const [sim] = extractSims({ numberSim1: "9876543210", nameSim1: "Jio" });
    assert.deepEqual(sim, { slot: 1, number: "9876543210", carrier: "Jio", iccid: "", type: "" });
});

test("normalizeDevice survives an empty record", () => {
    const device = normalizeDevice({}, "blank");
    assert.equal(device.id, "blank");
    assert.equal(device.modelName, "");
    assert.equal(device.status, "unknown");
    assert.deepEqual(device.sims, []);
    assert.equal(device.battery, null);
});

/* ----------------------------- messages ------------------------------ */

test("normalizeMessage derives direction from type, dir and addresses", () => {
    const incoming = normalizeMessage({ body: "hello", from: "999", type: "received", timestamp: 1700000000 }, "m1");
    assert.equal(incoming.direction, "in");
    assert.equal(incoming.from, "999");
    assert.equal(incoming.ts, 1700000000000);

    const outgoing = normalizeMessage({ message: "hi", to: "999", type: "sent" }, "m2");
    assert.equal(outgoing.direction, "out");
    assert.equal(outgoing.body, "hi");

    const byAddress = normalizeMessage(
        { body: "x", from: "+91 98765 43210", to: "111" },
        "m3",
        { deviceNumber: "9876543210" },
    );
    assert.equal(byAddress.direction, "out");

    const explicit = normalizeMessage({ body: "y", direction: "out", from: "1" }, "m4");
    assert.equal(explicit.direction, "out");
});

test("deviceIdFromMessage reads common device reference fields", () => {
    assert.equal(deviceIdFromMessage({ deviceId: "abc" }), "abc");
    assert.equal(deviceIdFromMessage({ device_id: "abc" }), "abc");
    assert.equal(deviceIdFromMessage({ device: 12345 }), "12345");
    assert.equal(deviceIdFromMessage({ ClientID: "xyz" }), "xyz");
    assert.equal(deviceIdFromMessage({ targetDeviceId: "t1" }), "t1");
    assert.equal(deviceIdFromMessage({ body: "no device here" }), "");
    assert.equal(deviceIdFromMessage({ device: { nested: true } }), "");
    assert.equal(deviceIdFromMessage(null), "");
    assert.equal(deviceIdFromMessage([1, 2]), "");
});

test("sortByTimeDesc puts newest first and keeps undated entries last", () => {
    const sorted = sortByTimeDesc([
        { id: "old", ts: 1000 },
        { id: "new", ts: 3000 },
        { id: "none", ts: null },
    ]);
    assert.deepEqual(sorted.map((m) => m.id), ["new", "old", "none"]);
});

/* ------------------------------ search ------------------------------- */

test("deviceMatches searches id, model, phone and SIM fields", () => {
    const device = normalizeDevice(
        { d_name: "Pixel", numberSim1: "9876543210", nameSim1: "Jio", ip: "10.0.0.5" },
        "abc123",
    );
    assert.equal(deviceMatches(device, ""), true);
    assert.equal(deviceMatches(device, "abc"), true);
    assert.equal(deviceMatches(device, "pixel"), true);
    assert.equal(deviceMatches(device, "98765"), true);
    assert.equal(deviceMatches(device, "jio"), true);
    assert.equal(deviceMatches(device, "10.0.0"), true);
    assert.equal(deviceMatches(device, "nokia"), false);
    assert.equal(deviceMatches(device, "pixel nokia"), false);
});

test("messageMatches searches body, sender and recipient", () => {
    const message = normalizeMessage({ body: "Your OTP is 4321", from: "VODAFONE", to: "999" }, "m");
    assert.equal(messageMatches(message, "otp"), true);
    assert.equal(messageMatches(message, "vodafone"), true);
    assert.equal(messageMatches(message, "999"), true);
    assert.equal(messageMatches(message, "nothing"), false);
});

/* --------------------------- presentation ---------------------------- */

test("relativeTime buckets timestamps", () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);
    assert.equal(relativeTime(now - 5_000, now), "just now");
    assert.equal(relativeTime(now - 12 * 60_000, now), "12m ago");
    assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
    assert.equal(relativeTime(now - 5 * 86_400_000, now), "5d ago");
    assert.equal(relativeTime(now - 60 * 86_400_000, now), "2mo ago");
    assert.equal(relativeTime(now - 800 * 86_400_000, now), "2y ago");
    assert.equal(relativeTime(null, now), "never");
    assert.equal(relativeTime(now + 10_000, now), "just now");
});

test("formatBytes switches units", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
    assert.equal(formatBytes(undefined), "0 B");
});

/* ------------------------------ lookup ------------------------------- */

test("normalizeMobile and isValidMobile validate input", () => {
    assert.equal(normalizeMobile("+91 98765-43210"), "919876543210");
    assert.equal(normalizeMobile("abc"), "");
    assert.equal(isValidMobile("9876543210"), true);
    assert.equal(isValidMobile("98765"), false);
    assert.equal(isValidMobile("1234567890123456"), false);
});

test("flattenResult expands nested objects and arrays", () => {
    assert.deepEqual(flattenResult({ a: 1, b: { c: 2 }, d: [{ e: 3 }] }), [
        ["a", 1],
        ["b.c", 2],
        ["d[0].e", 3],
    ]);
    assert.deepEqual(flattenResult("plain"), [["value", "plain"]]);
    assert.deepEqual(flattenResult(null), []);
});

test("checkMobile posts the documented body and header", async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, info: { name: "Test" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    try {
        const result = await checkMobile("9876543210", {
            endpoint: "https://example.com/api/sw/check-mobile",
            token: "secret-token",
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://example.com/api/sw/check-mobile");
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.headers["x-token"], "secret-token");
        assert.equal(calls[0].init.headers["Content-Type"], "application/json");
        assert.deepEqual(JSON.parse(calls[0].init.body), {
            mobile: "9876543210",
            token: "secret-token",
            initData: "",
        });
        assert.equal(result.status, 200);
        assert.equal(result.data.info.name, "Test");
    } finally {
        globalThis.fetch = original;
    }
});

test("checkMobile rejects bad input before any request", async () => {
    await assert.rejects(() => checkMobile("123", { endpoint: "https://x.dev", token: "t" }), /10–15 digits/);
    await assert.rejects(() => checkMobile("9876543210", { endpoint: "https://x.dev", token: "" }), /token/);
    await assert.rejects(() => checkMobile("9876543210", { endpoint: "", token: "t" }), /endpoint/);
});

test("checkMobile surfaces HTTP errors with status and body", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ message: "bad token" }), { status: 401 });

    try {
        await assert.rejects(
            () => checkMobile("9876543210", { endpoint: "https://x.dev", token: "t" }),
            (error) => {
                assert.equal(error.status, 401);
                assert.match(error.message, /401/);
                assert.match(error.message, /bad token/);
                return true;
            },
        );
    } finally {
        globalThis.fetch = original;
    }
});
