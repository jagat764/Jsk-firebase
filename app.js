/**
 * Firebase Manager Pro — UI layer.
 *
 * Talks to a Realtime Database through its REST API (see lib/db.js), so the
 * page loads no third-party script. Everything rendered from the database is
 * HTML-escaped.
 */

import {
    buildCandidatePaths,
    databaseLabel,
    deviceFieldScore,
    deviceMatches,
    formatBytes,
    formatTimestamp,
    isPingOnly,
    messageMatches,
    normalizeDatabaseUrl,
    normalizeDevice,
    normalizeMessage,
    objectEntries,
    relativeTime,
    sortByTimeDesc,
} from "./lib/detect.js";

import {
    connectionFromInput,
    probeConnection,
    readNode,
    readShallow,
} from "./lib/db.js";

import {
    DEFAULT_LOOKUP_ENDPOINT,
    LookupError,
    checkMobile,
    flattenResult,
} from "./lib/lookup.js";

/* ==================================================================== *
 * Constants
 * ==================================================================== */

const STORE_KEY = "fbmp.v1";
const MAX_DEVICES = 500;
const MAX_MESSAGES = 400;
const RESERVED = new Set([
    "messages", "message", "sms", "chats", "commands", "device_commands",
    "smsqueue", "sms_queue", "queues", "bot_users", "bots", "sms_forward",
    "guard", "licenses", "licence", "license", "_comments", "comments", "links",
    "proxies", "proxy", "admins", "admin", "config", "settings", "logs",
    "notifications", "stats", "meta", "server", "servers", "prices", "plans",
]);

/* ==================================================================== *
 * Persistence (this browser only)
 * ==================================================================== */

function defaultStore() {
    return {
        databases: [],
        activeUrl: "",
        lookup: { endpoint: DEFAULT_LOOKUP_ENDPOINT, token: "", initData: "" },
    };
}

function loadStore() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return defaultStore();
        const parsed = JSON.parse(raw);
        const base = defaultStore();
        return {
            databases: Array.isArray(parsed.databases) ? parsed.databases : [],
            activeUrl: typeof parsed.activeUrl === "string" ? parsed.activeUrl : "",
            lookup: { ...base.lookup, ...(parsed.lookup || {}) },
        };
    } catch {
        return defaultStore();
    }
}

function saveStore() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
        toast("Could not save settings — local storage is unavailable.", "error");
    }
}

let store = loadStore();

/* ==================================================================== *
 * Runtime state
 * ==================================================================== */

const runtime = {
    connection: null,
    activeUrl: "",
    layout: null,
    devices: [],
    deviceById: new Map(),
    messages: [],
    messagesByDevice: new Map(),
    selectedDeviceId: null,
    connected: false,
    tab: "devices",
    filter: "",
    statusFilter: "all",
    messageFilter: "",
    loading: false,
};

/* ==================================================================== *
 * DOM helpers
 * ==================================================================== */

const $ = (id) => document.getElementById(id);

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function toast(message, kind = "info", ttl = 4200) {
    const node = document.createElement("div");
    node.className = `toast toast-${kind}`;
    node.textContent = message;
    $("toasts").appendChild(node);
    setTimeout(() => node.remove(), ttl);
}

function setNotice(id, message, kind = "info") {
    const node = $(id);
    if (!node) return;
    if (!message) {
        node.className = "notice hidden";
        node.textContent = "";
        return;
    }
    node.className = `notice notice-${kind}`;
    node.textContent = message;
}

function openModal(id) {
    $(id).classList.remove("hidden");
    const focusable = $(id).querySelector("input, button");
    if (focusable && id === "searchModal") focusable.focus();
}

function closeModal(id) {
    $(id).classList.add("hidden");
}

function copyText(text, label = "Copied") {
    if (!navigator.clipboard?.writeText) {
        toast("Clipboard is not available in this browser.", "error");
        return;
    }
    navigator.clipboard.writeText(text).then(
        () => toast(`${label}.`, "success", 1800),
        () => toast("Could not copy to clipboard.", "error"),
    );
}

/* ==================================================================== *
 * Connection + layout detection
 * ==================================================================== */

function setConnectionState(kind, label) {
    const dot = $("connectionDot");
    dot.className = `dot dot-${kind}`;
    $("connectionLabel").textContent = label;
}

async function connect(url, { silent = false } = {}) {
    const connection = connectionFromInput(url);
    if (!connection) {
        setNotice("dbFeedback", "That does not look like a database URL.", "error");
        setConnectionState("error", "invalid URL");
        return false;
    }

    runtime.connection = { ...connection, displayUrl: normalizeDatabaseUrl(url) };
    runtime.activeUrl = normalizeDatabaseUrl(url);
    store.activeUrl = runtime.activeUrl;
    saveStore();

    setConnectionState("busy", "connecting…");
    if (runtime.loading) return false;
    runtime.loading = true;

    try {
        const probe = await probeConnection(connection);
        if (probe.empty) {
            runtime.connected = true;
            setConnectionState("ok", `${databaseLabel(url)} · empty`);
            setNotice("dbFeedback", "Connected, but the database has no top-level data at this path.", "warn");
            runtime.layout = null;
            runtime.devices = [];
            runtime.deviceById.clear();
            renderAll();
            return true;
        }

        const layout = await detectLayout(connection, probe.keys);
        runtime.layout = layout;

        await loadDevices();
        runtime.connected = true;

        setConnectionState("ok", `${databaseLabel(url)} · ${runtime.devices.length} devices`);
        setNotice("dbFeedback", "", "info");
        if (!silent) {
            toast(`Connected to ${databaseLabel(url)} — ${runtime.devices.length} device(s).`, "success");
        }
        renderAll();
        return true;
    } catch (error) {
        const message = error?.message || "Could not connect to the database.";
        runtime.connected = false;
        runtime.layout = null;
        runtime.devices = [];
        runtime.deviceById.clear();
        runtime.messagesByDevice.clear();
        runtime.selectedDeviceId = null;
        setConnectionState("error", "connection failed");
        setNotice("dbFeedback", message, "error");
        if (!silent) toast(message, "error");
        renderAll();
        return false;
    } finally {
        runtime.loading = false;
    }
}

async function detectLayout(connection, rootKeys) {
    const childKeysByNode = {};
    const parents = rootKeys.filter(
        (key) => /^all_/i.test(key) || /^(root|panel|db|database)$/i.test(key),
    );

    await Promise.all(
        parents.slice(0, 6).map(async (parent) => {
            try {
                const shallow = await readShallow(connection, parent);
                childKeysByNode[parent] = Object.keys(shallow);
            } catch {
                childKeysByNode[parent] = [];
            }
        }),
    );

    const candidates = buildCandidatePaths(rootKeys, childKeysByNode);
    const rejected = [];
    let devicePath = null;

    for (const candidate of candidates.slice(0, 8)) {
        try {
            const shallow = await readShallow(connection, candidate);
            const ids = Object.keys(shallow).slice(0, 4);
            if (ids.length === 0) continue;

            const samples = await Promise.all(
                ids.slice(0, 3).map(async (id) => {
                    try {
                        const { data } = await readNode(connection, `${candidate}/${id}`);
                        return data;
                    } catch {
                        return null;
                    }
                }),
            );

            const records = samples.filter(
                (record) => record && typeof record === "object" && !Array.isArray(record),
            );
            if (records.length === 0) continue;

            if (isPingOnly(records)) {
                rejected.push({ path: candidate, reason: "ping-only decoy" });
                continue;
            }

            const score = records.reduce((sum, record) => sum + deviceFieldScore(record), 0);
            if (score > 0) {
                devicePath = candidate;
                break;
            }
            rejected.push({ path: candidate, reason: "no device fields" });
        } catch {
            rejected.push({ path: candidate, reason: "unreadable" });
        }
    }

    return {
        rootKeys,
        devicePath,
        rejected,
        messageSource: resolveMessageSource(rootKeys),
    };
}

function resolveMessageSource(rootKeys) {
    const has = (key) => rootKeys.some((k) => k.toLowerCase() === key);
    if (has("user_sms")) return { type: "device-map", path: "user_sms" };
    if (has("messages")) return { type: "global", path: "messages" };
    if (has("sms")) return { type: "global", path: "sms" };
    return { type: "auto", path: "" };
}

async function loadDevices() {
    const { connection, layout } = runtime;
    runtime.devices = [];
    runtime.deviceById.clear();
    runtime.messagesByDevice.clear();

    if (!layout?.devicePath) {
        setNotice(
            "layoutNotice",
            "No device records were recognised in this database. Open the Data tab to inspect the detected layout and the rejected candidates.",
            "warn",
        );
        return;
    }

    const { data, bytes } = await readNode(connection, layout.devicePath);
    const entries = objectEntries(data);
    const capped = entries.slice(0, MAX_DEVICES);

    runtime.devices = capped
        .map(([id, raw]) => normalizeDevice(raw, id))
        .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    for (const device of runtime.devices) runtime.deviceById.set(device.id, device);

    const parts = [
        `Device records found at "${layout.devicePath}" (${formatBytes(bytes)} read).`,
    ];
    if (entries.length > MAX_DEVICES) {
        parts.push(`Showing the first ${MAX_DEVICES} of ${entries.length} records.`);
    }
    if (layout.rejected.length) {
        parts.push(
            `Skipped: ${layout.rejected.map((r) => `${r.path} (${r.reason})`).join(", ")}.`,
        );
    }
    setNotice("layoutNotice", parts.join(" "), entries.length > MAX_DEVICES ? "warn" : "info");
}

async function loadMessagesFor(deviceId, { force = false } = {}) {
    if (!deviceId) return [];
    if (!force && runtime.messagesByDevice.has(deviceId)) {
        return runtime.messagesByDevice.get(deviceId);
    }

    const { connection, layout, deviceById } = runtime;
    const device = deviceById.get(deviceId);
    if (!device || !layout) return [];

    const attempts = [];
    const source = layout.messageSource;

    if (source.type === "device-map") {
        attempts.push(`${source.path}/${deviceId}`);
    }
    if (source.type !== "global") {
        // Probe the device record itself for a nested message node.
        try {
            const subKeys = await readShallow(connection, `${layout.devicePath}/${deviceId}`);
            const nested = Object.keys(subKeys).filter((key) =>
                /^(sms|messages|chats|inbox|sent|outbox|message_list)$/i.test(key),
            );
            for (const key of nested) attempts.push(`${layout.devicePath}/${deviceId}/${key}`);
        } catch {
            /* the device node may be a leaf; ignore */
        }
    }

    let messages = [];
    let usedPath = "";

    for (const path of attempts) {
        try {
            const { data } = await readNode(connection, path, { limitToLast: MAX_MESSAGES });
            const list = messageListFrom(data, device);
            if (list.length) {
                messages = list;
                usedPath = path;
                break;
            }
        } catch {
            /* try the next candidate */
        }
    }

    if (!messages.length && source.type !== "device-map") {
        for (const path of [source.path || "messages", "messages", "sms"]) {
            if (!path) continue;
            try {
                const { data } = await readNode(connection, path, { limitToLast: MAX_MESSAGES });
                const list = messageListFrom(data, device, { filterByDevice: true });
                if (list.length) {
                    messages = list;
                    usedPath = path;
                    break;
                }
            } catch {
                /* next */
            }
        }
    }

    const record = { messages, path: usedPath };
    runtime.messagesByDevice.set(deviceId, record);
    return record;
}

function messageListFrom(data, device, { filterByDevice = false } = {}) {
    if (!data || typeof data !== "object") return [];

    let pairs = [];
    if (Array.isArray(data)) {
        pairs = data.map((entry, index) => [String(index), entry]);
    } else {
        const values = Object.values(data);
        const looksLikeRecord =
            values.length > 0 &&
            values.every((v) => v === null || (typeof v !== "object" && typeof v !== "undefined"));
        if (looksLikeRecord && ("body" in data || "message" in data || "text" in data)) {
            pairs = [["0", data]];
        } else {
            pairs = Object.entries(data);
        }
    }

    const list = pairs
        .filter(([, value]) => value && typeof value === "object")
        .map(([id, value]) =>
            normalizeMessage(value, id, { deviceNumber: device?.phoneNumber || "" }),
        );

    if (!filterByDevice) return sortByTimeDesc(list).slice(0, MAX_MESSAGES);

    const deviceIdFields = ["device", "deviceid", "device_id", "did", "senderdevice", "clientid", "uid", "user"];
    const matched = list.filter((message) => {
        const raw = message.raw || {};
        const lowerKeys = Object.keys(raw).map((k) => k.toLowerCase());
        const fieldKey = lowerKeys.find((k) => deviceIdFields.includes(k));
        if (!fieldKey) return false;
        const originalKey = Object.keys(raw).find((k) => k.toLowerCase() === fieldKey);
        return String(raw[originalKey]) === device.id;
    });

    return sortByTimeDesc(matched).slice(0, MAX_MESSAGES);
}

/* ==================================================================== *
 * Rendering
 * ==================================================================== */

function renderAll() {
    renderStats();
    renderDevices();
    renderMessages();
    renderDatabases();
    renderLayoutDetails();
    renderLookupPreview();
}

function renderStats() {
    const devices = runtime.devices;
    $("statTotal").textContent = devices.length ? String(devices.length) : "—";
    $("statOnline").textContent = devices.length
        ? String(devices.filter((d) => d.status === "online").length)
        : "—";
    $("statOffline").textContent = devices.length
        ? String(devices.filter((d) => d.status === "offline").length)
        : "—";

    const visible = filteredDevices();
    $("statShowing").textContent = devices.length ? String(visible.length) : "—";
}

function filteredDevices() {
    return runtime.devices.filter((device) => {
        if (runtime.statusFilter !== "all" && device.status !== runtime.statusFilter) {
            return false;
        }
        return deviceMatches(device, runtime.filter);
    });
}

function batteryMarkup(device) {
    if (device.battery === null || device.battery === undefined) {
        return `<span class="battery-none">battery —</span>`;
    }
    const level = device.battery;
    const cls = level <= 15 ? "critical" : level <= 35 ? "low" : "";
    return `
        <span class="battery">
            <span>${level}%</span>
            <span class="battery-track"><span class="battery-fill ${cls}" style="width:${level}%"></span></span>
        </span>`;
}

function statusBadge(device) {
    const cls = device.status === "online" ? "badge-online" : device.status === "offline" ? "badge-offline" : "badge-unknown";
    return `<span class="badge ${cls}">${esc(device.status)}</span>`;
}

function renderDevices() {
    const grid = $("deviceGrid");
    const devices = filteredDevices();

    if (!runtime.connection || !runtime.connected) {
        grid.innerHTML = `<div class="placeholder">Connect a database to list its devices.<br>Use the Data tab to add one.</div>`;
        return;
    }
    if (!runtime.devices.length) {
        grid.innerHTML = `<div class="placeholder">This database has no recognised device records.</div>`;
        return;
    }
    if (!devices.length) {
        grid.innerHTML = `<div class="placeholder">No device matches the current filter.</div>`;
        return;
    }

    grid.innerHTML = devices
        .map((device) => {
            const phone = device.phoneNumber ? esc(device.phoneNumber) : "—";
            const carrier = device.operator ? esc(device.operator) : device.sims.length ? `${device.sims.length} SIM` : "—";
            const seen = relativeTime(device.lastSeen);
            return `
            <button class="device-card" type="button" data-device="${esc(device.id)}">
                <div class="device-top">
                    <div style="min-width:0">
                        <span class="device-id">${esc(device.id)}</span>
                        <span class="device-model">${esc(device.modelName || "unknown model")}</span>
                    </div>
                    ${statusBadge(device)}
                </div>
                <div class="device-meta">
                    <span><b>Phone</b> ${phone}</span>
                    <span><b>Carrier</b> ${carrier}</span>
                    <span><b>Android</b> ${device.androidV ? esc(device.androidV) : "—"}</span>
                    <span><b>SIMs</b> ${device.sims.length}${device.dualSim ? " (dual)" : ""}</span>
                </div>
                ${batteryMarkup(device)}
                <div class="device-foot">
                    <span>seen ${esc(seen)}</span>
                    <span>${device.joined ? `joined ${esc(relativeTime(device.joined))}` : ""}</span>
                </div>
            </button>`;
        })
        .join("");
}

function renderMessages() {
    const list = $("messageList");
    const subtitle = $("messageSubtitle");
    const device = runtime.selectedDeviceId
        ? runtime.deviceById.get(runtime.selectedDeviceId)
        : null;

    $("messageBackBtn").classList.toggle("hidden", !device);

    if (!runtime.connection || !runtime.connected) {
        subtitle.textContent = "No database connected";
        list.innerHTML = `<div class="placeholder">Connect a database first.</div>`;
        return;
    }
    if (!device) {
        subtitle.textContent = "No device selected";
        list.innerHTML = `<div class="placeholder">Pick a device card to read its messages.</div>`;
        return;
    }

    subtitle.textContent = `${device.id} · ${device.phoneNumber || "no number"}`;
    const record = runtime.messagesByDevice.get(device.id);
    if (!record) {
        list.innerHTML = `<div class="placeholder">Loading messages…</div>`;
        return;
    }

    const messages = record.messages.filter((message) => messageMatches(message, runtime.messageFilter));
    if (!record.messages.length) {
        list.innerHTML = `<div class="placeholder">No message node was found for this device.<br>The feed stays empty when the database does not store SMS.</div>`;
        return;
    }
    if (!messages.length) {
        list.innerHTML = `<div class="placeholder">No message matches the current filter.</div>`;
        return;
    }

    list.innerHTML = messages
        .map((message) => {
            const peer = message.direction === "in" ? message.from : message.to;
            const body = message.body || "(empty message)";
            const when = message.ts ? relativeTime(message.ts) : "no timestamp";
            const title = message.ts ? formatTimestamp(message.ts) : "no timestamp";
            return `
            <article class="message message-${esc(message.direction)}">
                <div class="message-head">
                    <span class="message-peer">
                        <span class="badge badge-${esc(message.direction)}">${message.direction === "in" ? "IN" : "OUT"}</span>
                        ${esc(peer || "unknown")}
                    </span>
                    <span class="message-time" title="${esc(title)}">${esc(when)}</span>
                </div>
                <div class="message-body${message.body ? "" : " message-empty"}">${esc(body)}</div>
                ${message.body ? `<div class="message-actions"><button class="link-btn" type="button" data-copy="${esc(message.body)}">copy</button></div>` : ""}
            </article>`;
        })
        .join("");
}

function renderDatabases() {
    const container = $("dbList");
    const modals = $("dbModalList");
    const current = runtime.activeUrl;

    const itemMarkup = (entry) => {
        const active = entry.url === current;
        return `
        <div class="db-item ${active ? "db-item-active" : ""}">
            <div class="db-info">
                <div class="db-name">${esc(entry.label || databaseLabel(entry.url))}</div>
                <div class="db-url">${esc(entry.url)}</div>
            </div>
            <div class="db-actions">
                <button class="mini-btn" type="button" data-db-use="${esc(entry.url)}">${active ? "active" : "use"}</button>
                <button class="mini-btn danger" type="button" data-db-remove="${esc(entry.url)}">×</button>
            </div>
        </div>`;
    };

    const html = store.databases.length
        ? store.databases.map(itemMarkup).join("")
        : `<div class="placeholder">None saved yet. Add one above.</div>`;

    container.innerHTML = html;
    modals.innerHTML = html;

    $("layoutDetails").textContent = runtime.layout
        ? [
            `root keys: ${runtime.layout.rootKeys.join(", ") || "—"}`,
            `device node: ${runtime.layout.devicePath || "not detected"}`,
            `message source: ${runtime.layout.messageSource.type}${
                runtime.layout.messageSource.path ? ` (${runtime.layout.messageSource.path})` : ""
            }`,
            runtime.layout.rejected.length
                ? `skipped nodes: ${runtime.layout.rejected.map((r) => `${r.path} [${r.reason}]`).join(", ")}`
                : "skipped nodes: none",
        ].join("\n")
        : "Connect a database to inspect its structure.";
}

function renderLayoutDetails() {
    /* included in renderDatabases */
}

function addDatabase(url, label) {
    const normalized = normalizeDatabaseUrl(url);
    if (!normalized) {
        setNotice("dbFeedback", "That does not look like a database URL.", "error");
        return null;
    }
    const existing = store.databases.find((entry) => entry.url === normalized);
    if (existing) {
        if (label) existing.label = label;
        saveStore();
        return normalized;
    }
    store.databases.push({ url: normalized, label: label || "", addedAt: Date.now() });
    saveStore();
    return normalized;
}

function removeDatabase(url) {
    store.databases = store.databases.filter((entry) => entry.url !== url);
    if (store.activeUrl === url) {
        store.activeUrl = "";
        runtime.connection = null;
        runtime.connected = false;
        runtime.layout = null;
        runtime.devices = [];
        runtime.deviceById.clear();
        runtime.messagesByDevice.clear();
        setConnectionState("idle", "not connected");
    }
    saveStore();
    renderAll();
}

/* ---------------------------- device detail -------------------------- */

function renderDeviceModal(device) {
    const content = $("deviceModalContent");
    $("deviceModalTitle").textContent = device.id;
    $("deviceModalSub").textContent = device.modelName || "unknown model";

    const rows = [
        ["Status", device.status],
        ["Last seen", device.lastSeen ? `${formatTimestamp(device.lastSeen)} (${relativeTime(device.lastSeen)})` : "unknown"],
        ["Joined", device.joined ? formatTimestamp(device.joined) : "unknown"],
        ["Phone", device.phoneNumber || "—"],
        ["Carrier", device.operator || "—"],
        ["Battery", device.battery === null ? "—" : `${device.battery}%`],
        ["Android", device.androidV || "—"],
        ["IP", device.ip || "—"],
        ["Serial", device.serial || "—"],
        ["Registered", device.lastSeen ? relativeTime(device.lastSeen) : "—"],
    ];

    const sims = device.sims.length
        ? device.sims
              .map(
                  (sim) => `
            <div class="sim-card">
                <div class="sim-head">SIM slot ${esc(sim.slot ?? "?")}</div>
                <div class="kv"><span class="kv-key">Number</span><span class="kv-val">${esc(sim.number || "—")}</span></div>
                <div class="kv"><span class="kv-key">Carrier</span><span class="kv-val">${esc(sim.carrier || "—")}</span></div>
                <div class="kv"><span class="kv-key">ICCID</span><span class="kv-val">${esc(sim.iccid || "—")}</span></div>
                ${sim.type ? `<div class="kv"><span class="kv-key">Type</span><span class="kv-val">${esc(sim.type)}</span></div>` : ""}
            </div>`,
              )
              .join("")
        : `<div class="placeholder">No SIM details recorded.</div>`;

    content.innerHTML = `
        ${rows
            .map(
                ([key, value]) =>
                    `<div class="kv"><span class="kv-key">${esc(key)}</span><span class="kv-val">${esc(value)}</span></div>`,
            )
            .join("")}
        <div class="card-head" style="margin-top:12px"><span class="section-title">SIMs</span></div>
        ${sims}
        <div class="form-actions" style="margin-top:12px">
            <button class="btn btn-primary" type="button" data-messages-for="${esc(device.id)}">Open message feed</button>
            <button class="btn btn-ghost" type="button" data-copy="${esc(device.id)}">Copy device ID</button>
        </div>
        <details class="card card-muted" style="margin-top:10px">
            <summary class="section-title">Raw record</summary>
            <pre class="code-block">${esc(JSON.stringify(device.raw, null, 2))}</pre>
        </details>`;
    openModal("deviceModal");
}

/* ------------------------------ lookup ------------------------------- */

function renderLookupPreview() {
    const endpoint = $("lookupEndpoint").value.trim() || DEFAULT_LOOKUP_ENDPOINT;
    const token = $("lookupToken").value.trim() || "<token>";
    const mobile = $("lookupMobile").value.trim() || "<mobile>";
    const initData = $("lookupInitData").value;
    $("lookupPreview").textContent =
        `POST ${endpoint}\n` +
        `Content-Type: application/json\n` +
        `x-token: ${token}\n\n` +
        JSON.stringify({ mobile, token, initData }, null, 2);
}

function renderLookupResult(result) {
    const container = $("lookupResult");
    container.classList.remove("hidden");

    const flat = flattenResult(result.data);
    const rows = flat.length
        ? flat
              .map(
                  ([key, value]) =>
                      `<div class="kv"><span class="kv-key">${esc(key)}</span><span class="kv-val">${esc(
                          value === null || value === undefined ? "null" : String(value),
                      )}</span></div>`,
              )
              .join("")
        : `<div class="placeholder">The endpoint returned an empty payload.</div>`;

    container.innerHTML = `
        <div class="card-head">
            <span class="section-title">Result</span>
            <span class="section-hint">HTTP ${result.status} · ${result.ms} ms</span>
        </div>
        ${rows}
        <details class="card card-muted" style="margin-top:10px">
            <summary class="section-title">Raw response</summary>
            <pre class="code-block">${esc(
                typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2),
            )}</pre>
        </details>`;
}

async function submitLookup(event) {
    event.preventDefault();
    const mobile = $("lookupMobile").value.trim();
    const endpoint = $("lookupEndpoint").value.trim() || DEFAULT_LOOKUP_ENDPOINT;
    const token = $("lookupToken").value.trim();
    const initData = $("lookupInitData").value;

    $("lookupResult").classList.add("hidden");
    $("lookupSubmit").disabled = true;
    setNotice("lookupStatus", "Checking…", "info");

    try {
        const result = await checkMobile(mobile, { endpoint, token, initData });
        setNotice("lookupStatus", `Done in ${result.ms} ms (HTTP ${result.status}).`, "success");
        renderLookupResult(result);
    } catch (error) {
        const message =
            error instanceof LookupError ? error.message : "The lookup failed unexpectedly.";
        setNotice("lookupStatus", message, "error");
    } finally {
        $("lookupSubmit").disabled = false;
    }
}

/* --------------------------- global search --------------------------- */

function renderSearchResults(query) {
    const container = $("globalSearchResults");
    const q = query.trim();

    if (!q) {
        container.innerHTML = `<div class="placeholder">Type to search the loaded devices and messages.</div>`;
        return;
    }

    const devices = runtime.devices.filter((device) => deviceMatches(device, q)).slice(0, 25);
    const messages = [];
    for (const [deviceId, record] of runtime.messagesByDevice) {
        for (const message of record.messages) {
            if (messageMatches(message, q)) messages.push({ deviceId, message });
        }
    }
    const topMessages = messages.slice(0, 25);

    const deviceBlock = devices.length
        ? `<div class="section-title" style="padding:4px 2px">Devices (${devices.length})</div>` +
          devices
              .map(
                  (device) => `
            <button class="db-item" style="width:100%;text-align:left;cursor:pointer" type="button" data-device="${esc(device.id)}">
                <div class="db-info">
                    <div class="db-name">${esc(device.id)}</div>
                    <div class="db-url">${esc(device.modelName || "unknown model")} · ${esc(device.phoneNumber || "no number")} · ${esc(device.status)}</div>
                </div>
                <span class="mini-btn">open</span>
            </button>`,
              )
              .join("")
        : "";

    const messageBlock = topMessages.length
        ? `<div class="section-title" style="padding:10px 2px 4px">Messages (${messages.length}${messages.length > topMessages.length ? `, showing ${topMessages.length}` : ""})</div>` +
          topMessages
              .map(
                  ({ deviceId, message }) => `
            <button class="db-item" style="width:100%;text-align:left;cursor:pointer" type="button" data-messages-for="${esc(deviceId)}">
                <div class="db-info">
                    <div class="db-name">${esc(message.direction === "in" ? message.from : message.to) || "unknown"}</div>
                    <div class="db-url">${esc((message.body || "(empty)").slice(0, 80))}</div>
                    <div class="db-url">${esc(deviceId)} · ${esc(message.ts ? relativeTime(message.ts) : "no timestamp")}</div>
                </div>
            </button>`,
              )
              .join("")
        : "";

    container.innerHTML =
        deviceBlock + messageBlock ||
        `<div class="placeholder">Nothing matched “${esc(q)}”.</div>`;
}

/* ==================================================================== *
 * Navigation + events
 * ==================================================================== */

function switchTab(tab) {
    runtime.tab = tab;
    for (const name of ["devices", "messages", "lookup", "databases"]) {
        $(`tab-${name}`).classList.toggle("hidden", name !== tab);
        $(`nav${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle("nav-active", name === tab);
    }
    if (tab === "lookup") renderLookupPreview();
}

function selectDevice(deviceId, { goToMessages = false } = {}) {
    runtime.selectedDeviceId = deviceId;
    const device = runtime.deviceById.get(deviceId);
    if (!device) return;

    if (goToMessages) {
        switchTab("messages");
        renderMessages();
        loadMessagesFor(deviceId).then(() => {
            if (runtime.selectedDeviceId === deviceId) renderMessages();
        });
    } else {
        renderDeviceModal(device);
        if (!runtime.messagesByDevice.has(deviceId)) {
            loadMessagesFor(deviceId).catch(() => {});
        }
    }
}

function wireEvents() {
    // Tabs
    $("navDevices").addEventListener("click", () => switchTab("devices"));
    $("navMessages").addEventListener("click", () => switchTab("messages"));
    $("navLookup").addEventListener("click", () => switchTab("lookup"));
    $("navDatabases").addEventListener("click", () => switchTab("databases"));

    // Devices
    $("deviceFilter").addEventListener("input", (event) => {
        runtime.filter = event.target.value;
        renderStats();
        renderDevices();
    });
    $("statusFilter").addEventListener("change", (event) => {
        runtime.statusFilter = event.target.value;
        renderStats();
        renderDevices();
    });
    $("deviceGrid").addEventListener("click", (event) => {
        const card = event.target.closest("[data-device]");
        if (card) selectDevice(card.dataset.device);
    });

    // Messages
    $("messageFilter").addEventListener("input", (event) => {
        runtime.messageFilter = event.target.value;
        renderMessages();
    });
    $("messageBackBtn").addEventListener("click", () => switchTab("devices"));
    $("refreshMessagesBtn").addEventListener("click", async () => {
        const id = runtime.selectedDeviceId;
        if (!id) return toast("Select a device first.", "error");
        await loadMessagesFor(id, { force: true });
        if (runtime.selectedDeviceId === id) renderMessages();
    });
    $("messageList").addEventListener("click", (event) => {
        const copy = event.target.closest("[data-copy]");
        if (copy) copyText(copy.dataset.copy, "Message copied");
    });

    // Device modal
    $("deviceModalContent").addEventListener("click", (event) => {
        const copy = event.target.closest("[data-copy]");
        if (copy) copyText(copy.dataset.copy, "Copied");
        const feed = event.target.closest("[data-messages-for]");
        if (feed) {
            closeModal("deviceModal");
            selectDevice(feed.dataset.messagesFor, { goToMessages: true });
        }
    });

    // Databases
    $("addDbForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const url = $("dbUrlInput").value.trim();
        const label = $("dbLabelInput").value.trim();
        const normalized = addDatabase(url, label);
        if (!normalized) return;
        $("dbUrlInput").value = "";
        $("dbLabelInput").value = "";
        renderDatabases();
        await connect(normalized);
    });

    const dbClickHandler = async (event) => {
        const use = event.target.closest("[data-db-use]");
        if (use) {
            closeModal("dbModal");
            switchTab("devices");
            await connect(use.dataset.dbUse);
            return;
        }
        const remove = event.target.closest("[data-db-remove]");
        if (remove) {
            removeDatabase(remove.dataset.dbRemove);
            return;
        }
        const card = event.target.closest("[data-device]");
        if (card) {
            closeModal("searchModal");
            switchTab("devices");
            selectDevice(card.dataset.device);
            return;
        }
        const feed = event.target.closest("[data-messages-for]");
        if (feed) {
            closeModal("searchModal");
            selectDevice(feed.dataset.messagesFor, { goToMessages: true });
        }
    };

    $("dbList").addEventListener("click", dbClickHandler);
    $("dbModalList").addEventListener("click", dbClickHandler);
    $("globalSearchResults").addEventListener("click", dbClickHandler);

    $("dbManagerBtn").addEventListener("click", () => {
        renderDatabases();
        openModal("dbModal");
    });
    $("connectionPill").addEventListener("click", () => {
        renderDatabases();
        openModal("dbModal");
    });
    $("reloadBtn").addEventListener("click", async () => {
        if (!runtime.activeUrl) return toast("Add a database first.", "error");
        await connect(runtime.activeUrl);
    });

    // Search overlay
    $("searchBtn").addEventListener("click", () => {
        openModal("searchModal");
        $("globalSearchInput").value = "";
        renderSearchResults("");
    });
    $("globalSearchInput").addEventListener("input", (event) =>
        renderSearchResults(event.target.value),
    );

    // Lookup
    $("lookupForm").addEventListener("submit", submitLookup);
    for (const id of ["lookupEndpoint", "lookupToken", "lookupMobile", "lookupInitData"]) {
        $(id).addEventListener("input", renderLookupPreview);
    }
    $("lookupSaveBtn").addEventListener("click", () => {
        store.lookup = {
            endpoint: $("lookupEndpoint").value.trim() || DEFAULT_LOOKUP_ENDPOINT,
            token: $("lookupToken").value.trim(),
            initData: $("lookupInitData").value,
        };
        saveStore();
        toast("Lookup settings saved in this browser.", "success");
    });

    // Generic modal handling
    document.addEventListener("click", (event) => {
        const closer = event.target.closest("[data-close]");
        if (closer) closeModal(closer.dataset.close);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        for (const id of ["deviceModal", "dbModal", "searchModal"]) closeModal(id);
    });
}

/* ==================================================================== *
 * Boot
 * ==================================================================== */

function boot() {
    wireEvents();
    switchTab("devices");

    $("lookupEndpoint").value = store.lookup.endpoint || DEFAULT_LOOKUP_ENDPOINT;
    $("lookupToken").value = store.lookup.token || "";
    $("lookupInitData").value = store.lookup.initData || "";
    renderLookupPreview();

    renderAll();

    const requested = new URLSearchParams(location.search).get("db");
    const initial = requested ? normalizeDatabaseUrl(requested) : store.activeUrl;

    if (initial) {
        if (requested && !store.databases.some((entry) => entry.url === initial)) {
            addDatabase(initial, "");
        }
        connect(initial, { silent: true });
    } else {
        setConnectionState("idle", "not connected");
        switchTab("databases");
    }
}

boot();
