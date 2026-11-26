# Firebase Manager Pro

A single-page panel for **Firebase Realtime Databases that you own**. It lists the devices
recorded in a database, shows their enrolment details and the message log feed, and adds one
extra feature: a **mobile-number lookup** per device card.

The interface and data logic retain the **original v9 build** — same markup, CSS, tabs, layout
profiles, Firebase SDK path, and database switching. Existing command-write paths are enabled
without adding UI controls; the lookup toggle, sheet, and server proxy are the other additions.

```
index.html        original markup + lookup toggle / lookup sheet (additions only)
style.css         original stylesheet + ~1.3 KB of lookup styles at the end
app_v9.js         original application logic with existing Firebase command writes enabled
schemes.js        original layout catalogue; extraction engine NOT included
cfg_51805.js      original Firebase config / database URL handling
lookup-ui.js      the added feature: lookup mode, per-card chip, lookup sheet
lib/lookup.js     check-mobile client (+ /api/lookup proxy fallback)
api/lookup.js     same-origin proxy for the lookup endpoint
test/             12 unit tests (node --test) for the lookup client and proxy
```

## What was restored

`index.html`, `style.css`, `app_v9.js`, `cfg_51805.js` and the layout catalogue in `schemes.js`
come from the v9 source. Verified mechanically:

* `index.html` differs from v9 by **three insertions only** — the header lookup button, the
  lookup sheet markup, and the extra `<script>` tag. Nothing was renamed, removed or restyled.
* `style.css` starts with the v9 file byte-for-byte; the lookup styles are appended after it.
* `app_v9.js` keeps the original command payloads and write paths; the existing 17 Firebase
  writes use a shared `writeData` helper that calls the Firebase SDK `set()`. No UI controls or
  write flows were added or redesigned.

## The lookup

1. Press the **person_search** button in the header — lookup mode turns on (remembered in
   `localStorage`, body class `lookup-mode`).
2. Every device card gains a strip with the SIM number found on that card and a **Lookup** chip.
   The chip does not trigger the card's own tap-to-open-logs behaviour.
3. The chip opens the lookup sheet for that device's number. Set the endpoint and token once
   (settings icon); they are stored in this browser only, never compiled into the bundle.
4. The result is shown as a key/value list with the HTTP status, round-trip time and whether the
   request went through the proxy.

Request contract: `POST <endpoint>`, header `x-token: <token>`,
body `{"mobile":"…","token":"…","initData":""}`. Default endpoint:
`https://pricetrackerpro.fojadomain.fun/api/sw/check-mobile`.

### Why the proxy exists

That endpoint sends no CORS headers, so a browser on any other origin cannot call it directly.
`api/lookup.js` (a Vercel function, path `/api/lookup`) forwards the POST server-side. The client
tries the direct call first and falls back to the proxy automatically; `?direct=1` disables the
fallback. The proxy only accepts POST, only talks to allow-listed hosts
(`pricetrackerpro.fojadomain.fun`, extend with `LOOKUP_ALLOWED_HOSTS="host1,host2"`), rejects URL
credentials, caps the body at 8 KB and times out after 15 s.

## Database writes and permissions

The app's existing command actions can write their original payloads to Firebase: send-SMS
commands, fetch triggers, and the existing command-queue layouts. No new write button, toggle,
layout, tab, or command flow was added. These writes occur only when the existing command actions
are used.

Firebase still enforces access. The database's Realtime Database rules and any configured auth
must authorize writes for this app; enabling writes in the source does not bypass Firebase rules.
If writes are denied, check the Firebase rules/auth setup and the browser console for the SDK
permission error. Only connect to databases you own or are authorized to administer.

The following v9 feature remains intentionally absent:

* **The extraction engine.** `schemes.js` keeps the scheme catalogue (labels, root paths) so the
  Schemes tab renders exactly as before, but sibling-base discovery (`/csc1`…`/csc9`), bulk
  scanning of every base, phone-number harvesting, the "bad number" list and OTP lookup all
  return empty results. The tab reports "scanning is not included in this build".
* **Relay / proxy credential tables** are shown read-only from the database; nothing is
  registered or forwarded.

## Running it

ES modules do not load over `file://`:

```bash
python3 -m http.server 8000     # or: npm start
# open http://localhost:8000/?db=https%3A%2F%2Fmy-project-default-rtdb.firebaseio.com
```

`?db=<url>` presets the database; the header's database manager (storage icon) saves and switches
between several URLs in this browser only. Without `?db=` the original default URL is used.

## Deploying

Vercel, no build step: import the repository, framework **Other**, empty build command and output
directory. `vercel.json` keeps the security headers, gives `Clean URLs` and configures
`api/lookup.js` with a 20 s ceiling. After deploying, hard-refresh once so the new bundle replaces
the cached one.

## Tests

```bash
npm test                  # 12 assertions: lookup client + proxy handler
npm install --no-save jsdom
node .smoke/lookup.mjs    # 16 UI checks against index.html (toggle, chip, sheet, proxy fallback)
```

The lookup client tests cover the request shape, the CORS-triggered proxy fallback and the error
messages; the proxy tests cover method/host/mobile/token validation, forwarding, upstream errors
and the 502 path. The jsdom smoke test drives the real `index.html` and `lookup-ui.js`, including
that the injected chip does not fire the device card's own click handler.
