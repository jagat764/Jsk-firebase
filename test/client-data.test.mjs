import test from "node:test";
import assert from "node:assert/strict";

import {
    hasClientRecords,
    phoneNumbersForClient,
    providerForClient,
    simCountForClient,
} from "../lib/client-data.js";

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
    assert.equal(simCountForClient(client), 3);
});

test("falls back to SIM carrier names when provider has a non-text value", () => {
    assert.equal(
        providerForClient({ service_provider: { unexpected: true }, sims: [{ carrierName: "Airtel" }] }),
        "Airtel",
    );
    assert.equal(providerForClient(null), "—");
});
