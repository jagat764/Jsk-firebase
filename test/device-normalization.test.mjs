import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as clientData from "../lib/client-data.js";

const source = fs.readFileSync(new URL("../app_v9.js", import.meta.url), "utf8");
const start = source.indexOf("function isValidDeviceId");
const end = source.indexOf("function basePath(");
assert.notEqual(start, -1, "normalization helper region starts in app_v9.js");
assert.notEqual(end, -1, "normalization helper region ends in app_v9.js");

const context = {
    ...clientData,
    console,
    document: { getElementById: () => null },
    window: {},
};
vm.createContext(context);
vm.runInContext(
    `${source.slice(start, end)}\nglobalThis.testApi = { normalizeClient, normalizeClients, getCarriers, getSimBadge, getPhoneNumbers, getProviderLabel, getSimCount };`,
    context,
);
const api = context.testApi;

test("Type 6 All_User/Info + SimINFO sidecar normalizes carrier-only slot safely", () => {
    const client = api.normalizeClient(
        { Battery: "27", Id: "id-1", Name: "CPH2015", did: "device-1", status: "Offline" },
        { dualSim: "No", sim1: " - airtel", subID1: "2" },
    );

    assert.equal(client.modelName, "CPH2015");
    assert.equal(client.battery, "27");
    assert.equal(client.status, false);
    assert.equal(client.dualSim, false);
    assert.deepEqual(Array.from(api.getPhoneNumbers(client) || []), []);
    assert.deepEqual(Array.from(api.getCarriers(client)), ["airtel"]);
    assert.deepEqual(JSON.parse(JSON.stringify(api.getSimBadge(client))), { label: "1 SIM", dual: false });
});

test("Type 6 sidecar parses the stored phone and selects the carrier suffix", () => {
    const client = api.normalizeClient(
        { Name: "CPH2015", did: "device-2" },
        { sim1: "918197698337 - JIO 4G — Jio" },
    );

    assert.deepEqual(Array.from(api.getPhoneNumbers(client) || []), ["8197698337"]);
    assert.deepEqual(Array.from(api.getCarriers(client)), ["Jio"]);
    assert.deepEqual(JSON.parse(JSON.stringify(api.getSimBadge(client))), { label: "1 SIM", dual: false });
});

test("Type 3 RTX aliases preserve model, charge, status, and SIM1 phone", () => {
    const client = api.normalizeClient({
        device_name: "Redmi Note 9",
        charge: "64",
        Sim1: "9876500000",
        status: "Online",
    }, null);

    assert.equal(client.modelName, "Redmi Note 9");
    assert.equal(client.battery, "64");
    assert.equal(client.status, true);
    assert.deepEqual(Array.from(api.getPhoneNumbers(client)), ["9876500000"]);
});

test("Type 10 user_data extracts d_name, Device_info, and each live SIM field", () => {
    const raw = {
        Device_info: "Model: CPH2665\\nOS Version: Android 16\\nDevice Name: OPPO CPH2665\\nDevice ID: device-10",
        TimeandDate: "2026-11-08 03:33",
        battery: 36,
        d_name: "CPH2665",
        device: "device-10",
        iccIdSim1: "890123456789",
        iccIdSim2: "No Data",
        installTime: "2025-12-22 01:42:01",
        nameSim1: "airtel",
        nameSim2: "No SIM Found",
        numberSim1: "+919380780615",
        numberSim2: "No SIM Found",
        status: "online",
        typeSim1: "Physical SIM",
        typeSim2: "No SIM Found",
    };
    const client = api.normalizeClient(raw, null);

    assert.equal(client.modelName, "CPH2665");
    assert.equal(client.androidV, "16");
    assert.equal(client.joined, "2025-12-22 01:42:01");
    assert.equal(client.lastSeen, "2026-11-08 03:33");
    assert.equal(client.status, true);
    assert.deepEqual(Array.from(api.getPhoneNumbers(client) || []), ["9380780615"]);
    assert.deepEqual(Array.from(api.getCarriers(client)), ["airtel"]);
    assert.equal(api.getSimCount(client), 1);
    assert.equal(client.sims.length, 1);
    assert.equal(client.sims[0].iccid, "890123456789");
    assert.equal(client.sims[0].simType, "Physical SIM");
});

test("Type 10 dual SIM record retains both phone slots and carrier names", () => {
    const client = api.normalizeClient({
        d_name: "CPH2643",
        device: "device-dual",
        status: "online",
        battery: 28,
        nameSim1: "Jio",
        nameSim2: "Vi India",
        numberSim1: "919350515282",
        numberSim2: "919350515283",
        typeSim1: "Physical SIM",
        typeSim2: "Physical SIM",
    }, null);

    assert.equal(api.getSimCount(client), 2);
    assert.deepEqual(JSON.parse(JSON.stringify(api.getSimBadge(client))), { label: "2 SIM · DUAL", dual: true });
    assert.deepEqual(Array.from(api.getCarriers(client)), ["Jio", "Vi India"]);
    assert.deepEqual(Array.from(api.getPhoneNumbers(client)), ["9350515282", "9350515283"]);
});

test("normalizeClients associates the SIM sidecar by the record did", () => {
    const clients = api.normalizeClients({
        recordKey: { Name: "CPH2015", did: "device-sidecar" },
    }, {
        "device-sidecar": { sim1: "9876501234 - Carrier X" },
    });

    assert.deepEqual(Array.from(Object.keys(clients)), ["device-sidecar"]);
    assert.deepEqual(Array.from(api.getPhoneNumbers(clients["device-sidecar"])), ["9876501234"]);
    assert.deepEqual(Array.from(api.getCarriers(clients["device-sidecar"])), ["Carrier X"]);
});

test("a general phoneNumber does not falsely imply a physical SIM slot", () => {
    const client = api.normalizeClient({
        d_name: "CPH2487",
        device: "device-no-sim-fields",
        status: "online",
        phoneNumber: "7006970762",
    }, null);

    assert.equal(client.sims, undefined);
    assert.equal(api.getSimBadge(client), null);
    assert.deepEqual(Array.from(api.getPhoneNumbers(client)), ["7006970762"]);
});
