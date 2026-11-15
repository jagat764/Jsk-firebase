# Changelog

## v10.0.0 — rebuilt

The v9 folder was replaced. This build is a read-only inventory panel for databases you own;
the operational parts of v9 are gone rather than refactored.

### Removed

| v9 | v10 |
|---|---|
| Mass probing of generated Firebase URLs through a proxy pool | — |
| Relay / gateway ("bot users") configuration table | — |
| SMS forwarding target (`forward_number`) | — |
| Remote device commands (`fetch sms`, `send message`, `inline` dispatch) | — |
| Six-scheme phone-number extraction across arbitrary databases | — |
| Firebase JS SDK from `gstatic` CDN | REST API, no third-party script |
| Hardcoded default database URL in `cfg_51805.js` | database URL entered at runtime |

The panel now only reads a database you point it at, with bounded reads.

### Added

* **Layout auto-detection with decoy rejection.** Candidate nodes are sampled, scored by
  device fields, and ping-only nodes (`clients` / `devices` holding just `ping`) are skipped in
  favour of the real node — `user_data` in the Type 10 layout.
* **Bounded reads.** 500 devices, 400 messages, ≤8 sampled candidates, with the device
  payload size reported.
* **Device detail sheet.** Status, last seen, join date, battery, Android, IP, serial, every
  SIM slot (number / carrier / ICCID / type), copy-ID, raw JSON.
* **Relative last-seen** on every card (`just now`, `12m ago`, `3h ago`, `5d ago`, `2mo ago`).
* **Global search** across loaded devices and messages, jumping to the device or its feed.
* **Mobile lookup tab** for the `check-mobile` endpoint: configurable endpoint + token,
  request preview, latency, flattened result table, raw JSON, explicit CORS/timeout/HTTP error
  messages.
* **Database manager** — save/switch/remove connections, optional `?auth=`, live layout report
  including skipped candidates.
* **Friendly failure states** for 401, 403, network errors, non-JSON responses and empty
  databases.
* **28 unit tests** (`npm test`) covering the pure helpers and the lookup client.

### Field support carried over

`d_name` / `DeviceName` / `device_name` / `model` / `Device_info` → model ·
`battery` / `batt` / `charge` → level · `status` / `online` → state ·
`numberSim1..4` / `nameSim1..4` / `typeSim1..4` / `iccIdSim1..4` · `sims` / `SimINFO` maps and
arrays · RTX `Sim1` / `Sim2` · `installTime` / `joined` · `lastSeen` / `TimeandDate` /
`timestamp` / `ping.ts`. Dead SIM placeholders are filtered; `dualSim` is inferred from two or
more live SIMs.

## v10.1 — original UI restored, lookup toggle, feed auto-sync

* **Interface restored** to the original MATRIX COMMAND layout: header scope label, load bar
  with schema badge, stat strip (`On · Dev · Sms · Sim · Shown`), collapsible device sidebar
  with ALL/ON/OFF pills, two-pane main area, bottom nav, database manager sheet, and the
  global search overlay. Tailwind CDN + Material Icons as before.
* **Message feed fixed.** Messages are now aggregated for the whole database during connect —
  a per-device map node (`user_sms/<did>/<msgId>`), a global `messages` / `sms` node, or
  message nodes nested in device records — so the SMS Feed tab is populated immediately with
  no device preselection. Adds a device selector, direction filter, per-row copy and a
  "jump to device" action.
* **Lookup toggle** in the header; when enabled, every device card shows a `Lookup` button
  that checks that device's recorded number and renders the result in a sheet.
* Lookup endpoint/token/initData stay in the Lookup tab and in local storage — no credential
  is committed.
* Device cards, sidebar rows, JSON export and the detail sheet now share one normaliser, and
  `deviceIdFromMessage()` is unit-tested alongside the rest (29 assertions).
