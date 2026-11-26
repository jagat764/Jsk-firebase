import test from "node:test";
import assert from "node:assert/strict";

import { databaseReadUrl, shallowReadUrl } from "../lib/firebase-rest.js";

test("builds a root shallow-read URL with no phantom path segment", () => {
    const url = new URL(shallowReadUrl("https://demo-default-rtdb.firebaseio.com", "/"));
    assert.equal(url.pathname, "/.json");
    assert.equal(url.searchParams.get("shallow"), "true");
});

test("builds direct device-profile reads at /clients.json", () => {
    const url = new URL(databaseReadUrl("https://demo-default-rtdb.firebaseio.com", "/clients"));
    assert.equal(url.pathname, "/clients.json");
    assert.equal(url.searchParams.has("shallow"), false);
});

test("builds nested shallow-read paths and carries Firebase auth", () => {
    const url = new URL(
        shallowReadUrl(
            "https://demo-default-rtdb.firebaseio.com?auth=secret%2Bvalue",
            "/All_User/Info/",
        ),
    );
    assert.equal(url.pathname, "/All_User/Info.json");
    assert.equal(url.searchParams.get("shallow"), "true");
    assert.equal(url.searchParams.get("auth"), "secret+value");
});

test("encodes special characters in path segments", () => {
    const url = new URL(shallowReadUrl("https://demo.firebaseio.com", "messages/device id"));
    assert.equal(url.pathname, "/messages/device%20id.json");
});
