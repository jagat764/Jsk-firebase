/**
 * Tests for layout resolution (lib/schema.js) and the SimINFO sidecar merge.
 * Run with: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    SCHEMA_NAMES,
    detectSchemaType,
    effectiveSchema,
    nodeCandidates,
    pickSidecar,
    schemaName,
    simSidecarPath,
    UNIVERSAL_NODE_FALLBACKS,
} from "../lib/schema.js";

import { extractSims, normalizeDevice } from "../lib/detect.js";

/* --------------------------- schema names --------------------------- */

test("schemaName covers all ten layouts and falls back sensibly", () => {
    for (let type = 1; type <= 10; type += 1) {
        assert.equal(schemaName(type), SCHEMA_NAMES[type]);
        assert.match(schemaName(type), new RegExp(`^Type ${type} · `));
    }
    assert.equal(schemaName(11), "Type 11");
});

test("effectiveSchema honours a manual override", () => {
    assert.equal(effectiveSchema(null, 6), 6);
    assert.equal(effectiveSchema(undefined, 10), 10);
    assert.equal(effectiveSchema(3, 10), 3);
    assert.equal(effectiveSchema(0, 7), 7);
    assert.equal(effectiveSchema(2.5, 7), 7);
});

/* ------------------------- node candidates -------------------------- */

test("auto mode starts from the universal fallbacks", () => {
    const clients = nodeCandidates(null, "clients");
    assert.equal(clients[0], UNIVERSAL_NODE_FALLBACKS.clients[0]);
    assert.ok(clients.includes("user_data"));
    assert.ok(clients.includes("clients"));
    assert.ok(clients.includes("devices"));

    const messages = nodeCandidates(null, "messages");
    assert.deepEqual(
        messages.slice(0, UNIVERSAL_NODE_FALLBACKS.messages.length),
        UNIVERSAL_NODE_FALLBACKS.messages,
    );
});

test("forced types put their own aliases first, without duplicates", () => {
    assert.equal(nodeCandidates(1, "clients")[0], "clients");
    assert.equal(nodeCandidates(10, "clients")[0], "user_data");
    assert.equal(nodeCandidates(6, "clients")[0], "All_User/Info");
    assert.equal(nodeCandidates(7, "clients")[0], "All_Users/DeviceInfo");
    assert.equal(nodeCandidates(8, "clients")[0], "All_User/Data");
    assert.equal(nodeCandidates(10, "messages")[0], "user_sms");
    assert.equal(nodeCandidates(3, "messages")[0], "messages");

    for (const type of Object.keys(SCHEMA_NAMES).map(Number)) {
        for (const key of ["clients", "messages"]) {
            const list = nodeCandidates(type, key);
            assert.equal(new Set(list).size, list.length, `${type}/${key} has duplicates`);
            assert.ok(list.includes(key), `${type}/${key} lost its default node`);
        }
    }
});

test("unknown node kinds still return a usable candidate", () => {
    assert.deepEqual(nodeCandidates(1, "something"), ["something"]);
    assert.deepEqual(nodeCandidates(null, "something"), ["something"]);
});

/* --------------------------- SimINFO -------------------------------- */

test("simSidecarPath maps device nodes to their SimINFO sibling", () => {
    assert.equal(simSidecarPath("All_User/Info"), "All_User/SimINFO");
    assert.equal(simSidecarPath("All_Users/Info"), "All_Users/SimINFO");
    assert.equal(simSidecarPath("All_Users/DeviceInfo"), "All_Users/SimINFO");
    assert.equal(simSidecarPath("All_User/Data"), "All_User/SimINFO");
    assert.equal(simSidecarPath("user_data"), null);
    assert.equal(simSidecarPath("clients"), null);
    assert.equal(simSidecarPath(""), null);
});

test("pickSidecar prefers the record's did, then the node key", () => {
    const simsNode = {
        did1: { sim1: { phoneNumber: "9111111111" } },
        nodeKey: { sim1: { phoneNumber: "9222222222" } },
    };
    assert.deepEqual(pickSidecar(simsNode, "did1", "nodeKey", { did: "did1" }), simsNode.did1);
    assert.deepEqual(pickSidecar(simsNode, "other", "nodeKey", null), simsNode.nodeKey);
    assert.equal(pickSidecar(simsNode, "missing", "missing", null), null);
    assert.equal(pickSidecar(null, "a", "b", null), null);
});

test("sidecar SIM slots merge into the device record", () => {
    const raw = { device_name: "Galaxy S21", status: "Online", charge: "55" };
    const sidecar = {
        sim1: { phoneNumber: "9111111111", carrierName: "Jio" },
        sim2: { phoneNumber: "9222222222", carrierName: "Airtel" },
    };
    const device = normalizeDevice(raw, "did1", sidecar);

    assert.equal(device.modelName, "Galaxy S21");
    assert.equal(device.battery, 55);
    assert.equal(device.sims.length, 2);
    assert.equal(device.dualSim, true);
    assert.equal(device.phoneNumber, "9111111111");
    assert.equal(device.operator, "Jio");
});

test("inline SIM fields win over the sidecar", () => {
    const device = normalizeDevice(
        { numberSim1: "9000000000", nameSim1: "Inline" },
        "d",
        { sim1: { phoneNumber: "9111111111", carrierName: "Sidecar" } },
    );
    assert.equal(device.sims[0].number, "9000000000");
    assert.equal(device.sims[0].carrier, "Inline");
});

test("lowercase sim keys are read like RTX Sim keys", () => {
    const sims = extractSims({ sim1: "9876543210", sim2: { phoneNumber: "9876500000" } });
    assert.equal(sims.length, 2);
    assert.equal(sims[0].number, "9876543210");
    assert.equal(sims[1].number, "9876500000");
});

/* --------------------------- detection ------------------------------ */

test("detectSchemaType reads the type from the device node", () => {
    assert.equal(detectSchemaType({ clientsPath: "user_data" }).type, 10);
    assert.equal(detectSchemaType({ clientsPath: "All_User/Info" }).type, 6);
    assert.equal(detectSchemaType({ clientsPath: "All_Users/DeviceInfo" }).type, 7);
    assert.equal(detectSchemaType({ clientsPath: "All_User/Data" }).type, 8);
    assert.equal(detectSchemaType({ clientsPath: "clients" }).type, 1);

    const info = detectSchemaType({ clientsPath: "All_User/Info" });
    assert.match(info.evidence.join(" "), /info\+SimINFO/);
    const data = detectSchemaType({ clientsPath: "user_data" });
    assert.match(data.evidence.join(" "), /user_data/);
});

test("root smsQueue promotes All_User/Info to type 9", () => {
    const type6 = detectSchemaType({ clientsPath: "All_User/Info", rootSmsQueueDetected: false });
    assert.equal(type6.type, 6);

    const type9 = detectSchemaType({ clientsPath: "All_User/Info", rootSmsQueueDetected: true });
    assert.equal(type9.type, 9);
    assert.match(type9.evidence.join(" "), /root \/smsQueue/);
});

test("record fields refine the flat layouts", () => {
    assert.equal(
        detectSchemaType({ clientsPath: "clients", firstRecord: { Sim1: {}, device_name: "x" } }).type,
        3,
    );
    assert.equal(
        detectSchemaType({ clientsPath: "clients", firstRecord: { charge: "50" } }).type,
        3,
    );
    assert.equal(
        detectSchemaType({ clientsPath: "clients", firstRecord: { modelName: "Pixel" } }).type,
        1,
    );
    assert.equal(
        detectSchemaType({ clientsPath: "clients", firstRecord: { aadhaar: "1234", dob: "1/1/2000" } }).type,
        8,
    );
    assert.equal(
        detectSchemaType({ clientsPath: "clients", firstRecord: { PanCard: "ABCDE" } }).type,
        8,
    );
});

test("a sendSms message means a command-queue layout, but not for RTX", () => {
    const queue = detectSchemaType({
        clientsPath: "clients",
        firstRecord: { modelName: "Pixel" },
        messagesRecord: { sendSms: true, body: "x" },
    });
    assert.equal(queue.type, 2);
    assert.match(queue.evidence.join(" "), /sendSms/);

    const rtx = detectSchemaType({
        clientsPath: "clients",
        firstRecord: { device_name: "RTX" },
        messagesRecord: { sendSms: true },
    });
    assert.equal(rtx.type, 3);
});

test("detection always reports at least one evidence line", () => {
    const result = detectSchemaType({ clientsPath: "", firstRecord: null });
    assert.equal(result.type, 1);
    assert.equal(result.evidence.length, 1);
    assert.match(result.evidence[0], /default layout/);
});
