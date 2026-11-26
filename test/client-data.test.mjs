import test from "node:test";
import assert from "node:assert/strict";

import {
    carrierNamesForClient,
    firstSimMobile,
    hasClientRecords,
    mergeClientProfile,
    normalizeClientSims,
    parseDeviceInfoString,
    phoneNumbersForClient,
    providerForClient,
    simCountForClient,
} from "../lib/client-data.js";

test("merges nested device profile fields while retaining populated top-level values", () => {
    const profile = mergeClientProfile({
        data: {
            profile: {
                deviceInfo: {
                    model: "Pixel 8",
                    battery: 82,
                    androidVersion: "14",
                    cpuArch: "arm64-v8a",
                    ipAddress: "192.0.2.5",
                },
            },
        },
        profile: { mobNo: "9876543210", service_provider: "Airtel" },
        device: { deviceId: "nested-device-id" },
        model: "",
        modelName: "",
        battery: 0,
        status: false,
    });

    assert.equal(profile.model, "Pixel 8");
    assert.equal(profile.modelName, "");
    assert.equal(profile.deviceId, "nested-device-id");
    assert.equal(profile.battery, 0);
    assert.equal(profile.androidVersion, "14");
    assert.equal(profile.cpuArch, "arm64-v8a");
    assert.equal(profile.ipAddress, "192.0.2.5");
    assert.equal(profile.mobNo, "9876543210");
    assert.equal(profile.service_provider, "Airtel");
    assert.equal(profile.status, false);
});

test("parses multi-line Device_info into visible card fields and SIM slots", () => {
    const info = parseDeviceInfoString(
        "Model: Pixel 8\nAndroid Version: Android 14\nBattery Level: 87%\nIP Address: 10.0.0.8\nCPU Architecture: arm64-v8a\nTotal Storage: 128 GB\nSIM 1 Number: +91 9876543210\nSIM 1 Carrier: Airtel\nSIM 2: 9123456789 - Jio",
    );

    assert.equal(info.model, "Pixel 8");
    assert.equal(info.androidVersion, "Android 14");
    assert.equal(info.battery, "87%");
    assert.equal(info.ipAddress, "10.0.0.8");
    assert.equal(info.cpuArch, "arm64-v8a");
    assert.equal(info.storage, "128 GB");
    assert.deepEqual(normalizeClientSims(info), [
        { phoneNumber: "9876543210", carrierName: "Airtel", slot: 1 },
        { phoneNumber: "9123456789", carrierName: "Jio", slot: 2 },
    ]);
});

test("parses escaped newline separators in Firebase Device_info text", () => {
    assert.deepEqual(
        parseDeviceInfoString(String.raw`Model: Pixel 6\nIP Address: 192.0.2.8`),
        { model: "Pixel 6", ipAddress: "192.0.2.8" },
    );
});

test("parses JSON-formatted Device_info objects", () => {
    assert.deepEqual(parseDeviceInfoString('{"model":"Pixel 7","ipAddress":"192.0.2.4"}'), {
        model: "Pixel 7",
        ipAddress: "192.0.2.4",
    });
});

test("normalizes SIM sidecar objects, inline fields, carrier aliases and international numbers", () => {
    const sims = normalizeClientSims(
        {
            mobNo: "9876500000",
            numberSim2: "+91 9123456789",
            nameSim2: "Airtel",
            typeSim2: "5G",
        },
        {
            Sim1: {
                Number: "+91 9876543210",
                Carrier: "Jio",
                SimType: "LTE",
                IccId: "89012345",
            },
        },
    );
    const client = { sims };

    assert.deepEqual(sims, [
        { phoneNumber: "9876543210", carrierName: "Jio", simType: "LTE", iccid: "89012345", slot: 1 },
        { phoneNumber: "9123456789", carrierName: "Airtel", simType: "5G", slot: 2 },
    ]);
    assert.deepEqual(phoneNumbersForClient(client), ["9876543210", "9123456789"]);
    assert.deepEqual(carrierNamesForClient(client), ["Jio", "Airtel"]);
    assert.equal(providerForClient(client), "Jio | Airtel");
    assert.equal(simCountForClient(client), 2);
});

test("normalizes SIM arrays and numbered object maps", () => {
    assert.deepEqual(normalizeClientSims({
        sims: {
            slot1: { PhoneNumber: "9876501234", Operator: "VI" },
            slot2: { msisdn: "9123409876", network: "BSNL" },
        },
    }), [
        { phoneNumber: "9876501234", carrierName: "VI", slot: 1 },
        { phoneNumber: "9123409876", carrierName: "BSNL", slot: 2 },
    ]);
});

test("recognizes snake-case SIM slot aliases", () => {
    assert.deepEqual(normalizeClientSims({
        number_sim_1: "+91 9876543210",
        carrier_sim_1: "Airtel",
        sim_2: { phone_number: "9123456789", network: "Jio" },
    }), [
        { phoneNumber: "9876543210", carrierName: "Airtel", slot: 1 },
        { phoneNumber: "9123456789", carrierName: "Jio", slot: 2 },
    ]);
});

test("counts carrier-only slots and ignores dead SIM placeholders", () => {
    const sims = normalizeClientSims({
        nameSim1: "Airtel",
        numberSim2: "No SIM found",
        nameSim2: "Unknown",
        numberSim3: "9876501234",
    });
    assert.deepEqual(sims, [
        { carrierName: "Airtel", slot: 1 },
        { phoneNumber: "9876501234", slot: 3 },
    ]);
    assert.equal(simCountForClient({ sims }), 2);
});

test("ignores invalid nested profile containers", () => {
    assert.deepEqual(mergeClientProfile(null), {});
    assert.deepEqual(mergeClientProfile(["not", "a", "profile"]), {});
    assert.equal(mergeClientProfile({ data: [1, 2], name: "Device" }).name, "Device");
});

test("recognizes object-valued client records without normalizing the full payload", () => {
    assert.equal(hasClientRecords({ deviceA: { model: "Pixel" } }), true);
    assert.equal(hasClientRecords({ deviceA: null, deviceB: "bad record" }), false);
    assert.equal(hasClientRecords(null), false);
});

test("handles numeric and malformed phone fields without throwing", () => {
    const client = {
        mobNo: 9876543210,
        sims: [
            { phoneNumber: 9123456789 },
            { phone: " 9876501234 " },
            null,
            9876509999,
            { carrierName: "CarrierOnly" },
        ],
    };
    assert.deepEqual(phoneNumbersForClient(client), [
        "9876543210",
        "9123456789",
        "9876501234",
        "9876509999",
    ]);
    assert.equal(simCountForClient(client), 4);
    assert.deepEqual(phoneNumbersForClient({ mobNo: "No data", sims: [{ phone: "No SIM found" }] }), []);
});

test("deduplicates primary and SIM phones with country-code formatting", () => {
    assert.deepEqual(
        phoneNumbersForClient({ mobNo: "+91 9876543210", sims: [{ phoneNumber: "9876543210" }] }),
        ["+91 9876543210"],
    );
});

test("safely chooses the first usable SIM after null or malformed SIM entries", () => {
    assert.equal(firstSimMobile([null, {}, { phoneNumber: 9123456789 }]), "9123456789");
    assert.equal(firstSimMobile([null, { phoneNumber: "Unknown" }]), "");
    assert.equal(firstSimMobile(null), "");
});

test("falls back to SIM carrier names when provider has a non-text value", () => {
    assert.equal(
        providerForClient({ service_provider: { unexpected: true }, sims: [{ carrierName: "Airtel" }] }),
        "Airtel",
    );
    assert.equal(providerForClient(null), "—");
});
