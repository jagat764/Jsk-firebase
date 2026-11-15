# Firebase Manager Pro

A single-page admin panel for **Firebase Realtime Databases that you own**. It lists the
devices recorded in a database, shows their enrolment details and messages, and includes a
mobile-number lookup against an endpoint you configure.

Static files only — no build step, no backend, no third-party script loaded at runtime.
The panel talks to the database over the Realtime Database **REST API**, so every read is
bounded and the database URL is chosen at runtime.

```
index.html        markup
style.css         styles (handwritten, no CDN)
app.js            UI wiring, detection, rendering
lib/detect.js     pure helpers: URLs, layout detection, normalisation
lib/db.js         Realtime Database REST client
lib/lookup.js     check-mobile client
test/             28 unit tests (node --test)
```

## Running it

ES modules do not load over `file://`:

```bash
python3 -m http.server 8000
# or: npm start
# open http://localhost:8000
```

Point it straight at a database with `?db=`:

```
http://localhost:8000/?db=https://my-project-default-rtdb.firebaseio.com
```

## What it does

**Devices** — mirrors the device records in the database: model, battery, online/offline
state, last-seen ("12m ago"), join date, Android version, IP, serial and every SIM slot
(number, carrier, ICCID, type). Filter by ID, model, phone, carrier or IP, and narrow by
status. Opening a card shows the full record plus the raw JSON.

**Messages** — per-device SMS feed with IN/OUT badges, relative timestamps, text filter and
copy-to-clipboard. Three source layouts are tried in order: a per-device message node
(`user_sms/<id>` or a nested `sms`/`messages` child), then a global `messages` node filtered
by device id.

**Search** — the magnifier searches every loaded device and message at once; results jump
straight to the device or its message feed.

**Lookup** — checks a mobile number against a `check-mobile` style endpoint:

```
POST <endpoint>
Content-Type: application/json
x-token: <token>

{ "mobile": "9876543210", "token": "<token>", "initData": "" }
```

The response is flattened into a key/value table and the raw JSON is kept behind a
disclosure. Endpoint and token are entered in the UI and saved in this browser's local
storage — **no credential is compiled into the bundle**, so nothing secret is committed when
you deploy the folder.

**Databases** — save several database URLs, switch between them, and see a live layout report
(root keys, detected device node, message source, skipped candidates). A database secret can
be appended as `?auth=…`; it is sent only to that database, and stored unencrypted in local
storage.

## Layout detection

Root keys are read shallow, then candidate device nodes are sampled and scored. The first
candidate whose records actually carry device fields wins:

1. nested containers — `All_User/Info`, `All_Users/DeviceInfo`, `All_User/Data`
2. flat nodes — `user_data`, `Info`, `Data`, `clients`, `devices`, `users`, …
3. any remaining root node that is not configuration/queue data

`clients` and `devices` are sometimes **ping decoys** — records whose only field is
`ping: { ts, wake }`. When every sample record is ping-only (or carries no device fields) the
candidate is rejected and detection falls through to the real node, e.g. `user_data`. The
rejected candidates are always reported in the Data tab.

Field aliases handled: `d_name` / `DeviceName` / `device_name` / `model` / `Device_info` for the
model, `battery` / `batt` / `charge` for the level, `status` / `online` for the state, and so
on. SIMs are read from `numberSim1..4` + `nameSim1..4` + `typeSim1..4` + `iccIdSim1..4`, from a
`sims` / `SimINFO` map or array, and from the RTX `Sim1` / `Sim2` keys. Dead placeholders
(`No SIM Found`, `No Data`, `Not Available`, `Unknown`) are dropped instead of being shown as
phone numbers.

## Deliberate limits

Reads are capped — 500 devices, 400 messages, up to 8 sampled candidates — and the payload
size of the device read is reported. Very large databases should be split per project.

## What this panel does not do

It is an inventory and read-only viewer for your own deployments. It deliberately has no
random-URL probing or proxy rotation, no bulk phone-number extraction from arbitrary
databases, no SMS forwarding configuration, and no remote device commands
(`fetch sms`, `send message`). Removed in v10 — see `CHANGES.md`.

## Tests

```bash
npm test        # node --test
```

28 assertions over URL parsing, candidate ordering, ping-decoy rejection, field/SIM
normalisation (inline SIMs, sidecar maps, RTX keys), dead-value filtering, timestamps
(seconds, ms, ISO, `DD/MM/YYYY`), message direction, search matching, relative time, and the
lookup client's request shape and error handling (via a stubbed `fetch`).

## Browser notes

* The lookup call is a cross-origin `POST`. If the endpoint does not send CORS headers the
  browser blocks it — the panel reports that case explicitly. Serve the panel from the same
  origin as the endpoint, or call the endpoint from your own server.
* Database secrets live in `localStorage`; use a dedicated browser profile on shared machines.
* `?auth=` URLs end up in browser history — prefer rules-based read access where possible.
