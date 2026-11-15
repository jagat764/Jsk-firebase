/**
 * Matrix Command — Firebase Manager Pro (v10 UI)
 *
 * Read-only inventory for Realtime Databases you own: device cards, log feed,
 * and a mobile lookup you can run per device or by hand.
 *
 * Database access goes through the REST API (lib/db.js) — no SDK, no backend.
 */

import {
    databaseLabel,
    deviceFieldScore,
    deviceIdFromMessage,
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
    sameNumber,
} from "./lib/detect.js";

import {
    connectionFromInput,
    probeConnection,
    readNode,
    readShallow,
} from "./lib/db.js";

import {
    SCHEMA_NAMES,
    detectSchemaType,
    effectiveSchema,
    nodeCandidates,
    pickSidecar,
    schemaName,
    simSidecarPath,
} from "./lib/schema.js";

import {
    DEFAULT_LOOKUP_ENDPOINT,
    LookupError,
    checkMobile,
    flattenResult,
    isValidMobile,
    normalizeMobile,
} from "./lib/lookup.js";

/* ==================================================================== *
 * Constants / persistence
 * ==================================================================== */

const STORE_KEY = "fbmp.v1";
const MAX_DEVICES = 500;
const MAX_MESSAGES = 800;
const MAX_MESSAGE_DEVICES = 60;
const PER_DEVICE_MESSAGE_LIMIT = 150;

function defaultStore() {
    return {
        databases: [],
        activeUrl: "",
        lookupEnabled: false,
        schemaOverride: null,
        lookup: { endpoint: DEFAULT_LOOKUP_ENDPOINT, token: "", initData: "" },
    };
}

function loadStore() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        const base = defaultStore();
        if (!raw) return base;
        const parsed = JSON.parse(raw);
        return {
            databases: Array.isArray(parsed.databases) ? parsed.databases : [],
            activeUrl: typeof parsed.activeUrl === "string" ? parsed.activeUrl : "",
            lookupEnabled: Boolean(parsed.lookupEnabled),
            schemaOverride:
                Number.isInteger(parsed.schemaOverride) && parsed.schemaOverride >= 1
                    ? parsed.schemaOverride
                    : readSchemaOverrideKey(),
            lookup: { ...base.lookup, ...(parsed.lookup || {}) },
        };
    } catch {
        return defaultStore();
    }
}

let store = loadStore();

/** The original build kept the override under its own key — honour it. */
function readSchemaOverrideKey() {
    try {
        const raw = localStorage.getItem("fbSchemaOverride");
        const value = Number.parseInt(raw ?? "", 10);
        return Number.isInteger(value) && value >= 1 ? value : null;
    } catch {
        return null;
    }
}

function writeSchemaOverrideKey(override) {
    try {
        localStorage.setItem("fbSchemaOverride", override === null ? "auto" : String(override));
    } catch {
        /* private mode */
    }
}

function saveStore() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        writeSchemaOverrideKey(store.schemaOverride);
    } catch {
        toast("Settings could not be saved — local storage is unavailable.", "error");
    }
}

/* ==================================================================== *
 * Runtime state
 * ==================================================================== */

const runtime = {
    connection: null,
    activeUrl: "",
    connected: false,
    layout: null,
    devices: [],
    deviceById: new Map(),
    deviceList: null,          // flat list of device ids before normalisation
    detectedSchema: 1,
    schemaEvidence: [],
    commandPath: "",
    messages: [],              // aggregated, normalised, newest first
    messageIndex: new Map(),   // deviceId -> normalised messages
    messageSourceLabel: "",
    selectedDeviceId: "",
    messageDeviceFilter: "",
    messageDirectionFilter: "all",
    deviceQuery: "",
    statusFilter: "all",
    panelQuery: "",
    tab: "clients",
    loading: false,
};

/* ==================================================================== *
 * Tiny DOM helpers
 * ==================================================================== */

const $ = (id) => document.getElementById(id);
const show = (id) => $(id)?.classList.remove("hidden");
const hide = (id) => $(id)?.classList.add("hidden");

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function toast(message, kind = "info", ttl = 4000) {
    const host = $("toastNotificationContainer");
    if (!host) return;
    const node = document.createElement("div");
    node.className = `toast-item toast-${kind} pointer-events-auto`;
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), ttl);
}

function setNotice(message, kind = "info") {
    const node = $("layoutNotice");
    if (!node) return;
    if (!message) {
        node.className = "hidden";
        node.textContent = "";
        return;
    }
    node.className = `notice-${kind} text-[10px] font-mono leading-relaxed rounded-xl border px-3 py-2`;
    node.textContent = message;
}

function setConnectionPill(state, text) {
    const colours = {
        idle: "bg-slate-400",
        busy: "bg-amber-400 animate-ping",
        ok: "bg-emerald-400",
        error: "bg-rose-500",
    };
    const dot = $("connectionStatus").querySelector("span");
    dot.className = `w-1 h-1 rounded-full ${colours[state] || colours.idle}`;
    $("connectionStatusText").textContent = text;
    $("activeDbDot").className = `w-1.5 h-1.5 rounded-full flex-shrink-0 ${
        state === "ok" ? "bg-emerald-400" : state === "error" ? "bg-rose-500" : "bg-slate-600"
    }`;
}

function setProgress(percent) {
    $("loadProgressBar").style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setLoadStatus(text) {
    $("loadStatusText").textContent = text;
}

function copyText(text, label = "Copied") {
    if (!navigator.clipboard?.writeText) {
        toast("Clipboard is not available in this browser.", "error");
        return;
    }
    navigator.clipboard.writeText(text).then(
        () => toast(`${label}.`, "success", 1600),
        () => toast("Could not copy to clipboard.", "error"),
    );
}

function openModal(id) {
    $(id)?.classList.remove("hidden");
}

function closeModal(id) {
    $(id)?.classList.add("hidden");
}

/* ==================================================================== *
 * Connection + layout detection
 * ==================================================================== */

async function connect(url, { silent = false } = {}) {
    const connection = connectionFromInput(url);
    if (!connection) {
        toast("That does not look like a database URL.", "error");
        setConnectionPill("error", "INVALID URL");
        return false;
    }
    if (runtime.loading) return false;

    const displayUrl = normalizeDatabaseUrl(url);
    runtime.connection = { ...connection };
    runtime.activeUrl = displayUrl;
    store.activeUrl = displayUrl;
    saveStore();
    updateDbHeader(displayUrl);

    runtime.loading = true;
    setConnectionPill("busy", "CONNECTING");
    setProgress(8);
    setLoadStatus("Connecting to database…");
    setNotice("");

    try {
        const probe = await probeConnection(connection);
        setProgress(25);

        if (probe.empty) {
            runtime.layout = null;
            runtime.devices = [];
            runtime.messages = [];
            runtime.deviceById.clear();
            runtime.messageIndex.clear();
            runtime.connected = true;
            runtime.detectedSchema = 0;
            runtime.schemaEvidence = ["database is empty"];
            setConnectionPill("ok", "EMPTY");
            renderSchemaBadge();
            setLoadStatus("Connected — database has no data at this path.");
            setProgress(100);
            renderEverything();
            if (!silent) toast("Connected, but the database is empty.", "warn");
            return true;
        }

        setLoadStatus("Resolving layout…");
        const clients = await resolveClients(connection);
        const sidecarPath = clients.clientsPath ? simSidecarPath(clients.clientsPath) : null;
        runtime.layout = {
            rootKeys: probe.keys,
            clientsPath: clients.clientsPath,
            rawClients: clients.rawClients,
            simsNode: clients.simsNode,
            simsPath: sidecarPath || "",
            skipped: clients.skipped,
        };
        setProgress(45);

        setLoadStatus("Reading device records…");
        await loadDevices();
        setProgress(60);

        setLoadStatus("Reading message logs…");
        await loadMessages();
        setProgress(85);

        setLoadStatus("Detecting layout…");
        const commands = await probeCommandLayout(connection);
        const firstEntry = objectEntries(clients.rawClients || {})[0];
        const detection = detectSchemaType({
            clientsPath: clients.clientsPath,
            firstRecord: firstEntry ? firstEntry[1] : null,
            messagesRecord: runtime.firstMessageRecord,
            rootSmsQueueDetected: commands.rootSmsQueue,
        });
        runtime.detectedSchema = detection.type;
        runtime.schemaEvidence = detection.evidence;
        runtime.commandPath = commands.commandPath;
        setProgress(100);

        runtime.connected = true;
        setConnectionPill("ok", "LIVE");
        renderSchemaBadge();
        setLoadStatus(
            `Synced · ${runtime.devices.length} devices · ${runtime.messages.length} messages`,
        );
        renderEverything();

        if (!silent) {
            toast(
                `Connected to ${databaseLabel(displayUrl)} — ${runtime.devices.length} device(s), ${runtime.messages.length} message(s).`,
                "success",
            );
        }
        return true;
    } catch (error) {
        const message = error?.message || "Could not connect to the database.";
        runtime.connected = false;
        runtime.layout = null;
        runtime.devices = [];
        runtime.messages = [];
        runtime.deviceById.clear();
        runtime.messageIndex.clear();
        setConnectionPill("error", "FAILED");
        setProgress(100);
        setLoadStatus(message);
        setNotice(message, "error");
        runtime.detectedSchema = 0;
        runtime.schemaEvidence = [message];
        renderSchemaBadge();
        renderEverything();
        if (!silent) toast(message, "error", 7000);
        return false;
    } finally {
        runtime.loading = false;
    }
}

function updateDbHeader(url) {
    const label = databaseLabel(url);
    $("activeDbName").textContent = label === "not connected" ? "not connected" : label;
    $("activeDbHost").textContent = (() => {
        try {
            return new URL(url.replace(/\/+$/, "")).hostname.split(".").slice(-3).join(".");
        } catch {
            return "firebaseio.com";
        }
    })();
}

function renderSchemaBadge() {
    const el = $("schemaBadge");
    const detected = runtime.detectedSchema || 1;
    const manual = Number.isInteger(store.schemaOverride) && store.schemaOverride >= 1;
    const active = effectiveSchema(store.schemaOverride, detected);
    const evidence = runtime.schemaEvidence.length
        ? runtime.schemaEvidence.join(" · ")
        : "no evidence yet — connect a database";

    el.textContent = `${schemaName(active)}${manual ? " · manual" : ""}`;
    el.title = manual
        ? `Manual override. Auto-detect said ${schemaName(detected)} — ${evidence}`
        : evidence;
    el.classList.toggle("schema-manual", manual);
}

/** Read the node list behind a path, tolerating missing nodes. */
async function shallowKeys(connection, path) {
    try {
        return Object.keys(await readShallow(connection, path));
    } catch {
        return [];
    }
}

/**
 * Locate the device node exactly like the original loader: walk the candidate
 * list for the active schema, skip ping-only decoys, keep the SimINFO sidecar
 * when the layout stores SIM data outside the device record.
 */
async function resolveClients(connection) {
    const candidates = nodeCandidates(store.schemaOverride, "clients");
    const skipped = [];
    let clientsPath = "";
    let rawClients = null;
    let simsNode = null;

    for (const candidate of candidates.slice(0, 9)) {
        try {
            const { data } = await readNode(connection, candidate);
            const entries = objectEntries(data);
            if (!entries.length) continue;

            if (isPingOnly(entries.map(([, value]) => value))) {
                skipped.push(`${candidate}: ping-only decoy`);
                continue;
            }
            const score = entries
                .slice(0, 3)
                .reduce((sum, [, value]) => sum + deviceFieldScore(value), 0);
            if (score === 0) {
                skipped.push(`${candidate}: no device fields`);
                continue;
            }

            clientsPath = candidate;
            rawClients = data;

            const sidecarPath = simSidecarPath(candidate);
            if (sidecarPath) {
                try {
                    simsNode = (await readNode(connection, sidecarPath)).data;
                } catch {
                    simsNode = null;
                }
            }
            break;
        } catch {
            skipped.push(`${candidate}: unreadable`);
        }
    }

    return { clientsPath, rawClients, simsNode, skipped };
}

/** Does this record look like a message rather than a device? */
function looksLikeMessageRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const keys = Object.keys(record).map((key) => key.toLowerCase());
    const bodies = ["body", "message", "text", "msg", "content", "sms"];
    const meta = ["from", "sender", "to", "address", "timestamp", "time", "date", "type"];
    return (
        bodies.some((key) => keys.includes(key)) ||
        meta.filter((key) => keys.includes(key)).length >= 2
    );
}

/**
 * Load messages from the first candidate node that actually holds records.
 * A global list node (message ids as keys) is read in one bounded call; a
 * per-device map (device ids as keys) is read device by device, capped like the
 * original build (60 devices × 150 messages).
 */
async function resolveMessages(connection) {
    const candidates = nodeCandidates(store.schemaOverride, "messages");
    const collected = [];
    const seen = new Set();
    let firstRecord = null;
    let label = "";

    const add = (deviceId, list) => {
        for (const message of list) {
            const key = `${deviceId}|${message.id}|${message.ts ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!firstRecord && message.raw) firstRecord = message.raw;
            collected.push({ ...message, deviceId });
        }
    };

    for (const candidate of candidates) {
        const keys = await shallowKeys(connection, candidate);
        if (!keys.length) continue;

        let sample = null;
        try {
            sample = (await readNode(connection, `${candidate}/${keys[0]}`)).data;
        } catch {
            sample = null;
        }

        if (looksLikeMessageRecord(sample)) {
            try {
                const { data } = await readNode(connection, candidate, { limitToLast: MAX_MESSAGES });
                for (const [id, raw] of messagePairs(data)) {
                    const deviceId = deviceIdFromMessage(raw) || matchDeviceByAddress(raw) || "unassigned";
                    const device = runtime.deviceById.get(deviceId);
                    add(deviceId, [
                        normalizeMessage(raw, id, { deviceNumber: device?.phoneNumber || "" }),
                    ]);
                }
                if (collected.length) {
                    label = `${candidate} · global list`;
                    break;
                }
            } catch {
                /* next candidate */
            }
            continue;
        }

        const batch = keys.slice(0, MAX_MESSAGE_DEVICES);
        const results = await Promise.all(
            batch.map(async (deviceId) => {
                try {
                    const { data } = await readNode(connection, `${candidate}/${deviceId}`, {
                        limitToLast: PER_DEVICE_MESSAGE_LIMIT,
                    });
                    return [deviceId, messagePairs(data)];
                } catch {
                    return [deviceId, []];
                }
            }),
        );

        for (const [deviceId, pairs] of results) {
            const device = runtime.deviceById.get(deviceId);
            add(
                deviceId,
                pairs.map(([id, raw]) =>
                    normalizeMessage(raw, id, { deviceNumber: device?.phoneNumber || "" }),
                ),
            );
        }
        if (collected.length) {
            label = `${candidate} · ${batch.length} device node(s)`;
            break;
        }
    }

    // Last resort — message nodes nested inside each device record.
    if (!collected.length && runtime.layout?.clientsPath) {
        const batch = runtime.devices.slice(0, 40);
        const results = await Promise.all(
            batch.map(async (device) => {
                try {
                    const subKeys = await shallowKeys(
                        connection,
                        `${runtime.layout.clientsPath}/${device.id}`,
                    );
                    const nested = subKeys.filter((key) =>
                        /^(sms|messages|chats|inbox|sent|outbox|message_list)$/i.test(key),
                    );
                    if (!nested.length) return [device.id, []];
                    const { data } = await readNode(
                        connection,
                        `${runtime.layout.clientsPath}/${device.id}/${nested[0]}`,
                        { limitToLast: PER_DEVICE_MESSAGE_LIMIT },
                    );
                    return [device.id, messagePairs(data)];
                } catch {
                    return [device.id, []];
                }
            }),
        );
        for (const [deviceId, pairs] of results) {
            const device = runtime.deviceById.get(deviceId);
            add(
                deviceId,
                pairs.map(([id, raw]) =>
                    normalizeMessage(raw, id, { deviceNumber: device?.phoneNumber || "" }),
                ),
            );
        }
        if (collected.length) label = `${runtime.layout.clientsPath}/<id> · nested`;
    }

    return { messages: sortByTimeDesc(collected).slice(0, MAX_MESSAGES), firstRecord, label };
}

/**
 * Type 9 vs Type 6 hinges on whether commands live under All_User/Commands or
 * as a root /smsQueue node. Read-only probe — nothing is written.
 */
async function probeCommandLayout(connection) {
    const commands = (await shallowKeys(connection, "All_User/Commands")).length
        ? "All_User/Commands"
        : (await shallowKeys(connection, "All_Users/Commands")).length
          ? "All_Users/Commands"
          : "";
    if (commands) return { commandPath: commands, rootSmsQueue: false };
    const rootQueue = (await shallowKeys(connection, "smsQueue")).length > 0;
    return { commandPath: rootQueue ? "smsQueue" : "", rootSmsQueue: rootQueue };
}

async function loadDevices() {
    if (!runtime.layout?.clientsPath || !runtime.layout.rawClients) {
        runtime.devices = [];
        runtime.deviceById.clear();
        setNotice(
            "No device records were recognised in this database. Force a layout in the Data tab if the shape is unusual.",
            "warn",
        );
        return;
    }

    const entries = objectEntries(runtime.layout.rawClients);
    const capped = entries.slice(0, MAX_DEVICES);
    const simsNode = runtime.layout.simsNode;

    runtime.devices = capped
        .map(([id, raw]) =>
            normalizeDevice(raw, id, pickSidecar(simsNode, raw?.did || id, id, raw)),
        )
        .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    runtime.deviceById.clear();
    for (const device of runtime.devices) runtime.deviceById.set(device.id, device);

    const notes = [`Device records at "${runtime.layout.clientsPath}".`];
    if (simsNode) notes.push(`SIM sidecar merged (${runtime.layout.simsPath}).`);
    if (entries.length > MAX_DEVICES) notes.push(`Showing first ${MAX_DEVICES} of ${entries.length}.`);
    if (runtime.layout.skipped.length) notes.push(`Skipped → ${runtime.layout.skipped.join(", ")}.`);
    setNotice(notes.join(" "), entries.length > MAX_DEVICES ? "warn" : "info");
}

async function loadMessages() {
    if (!runtime.layout) return;
    const result = await resolveMessages(runtime.connection);
    runtime.messages = result.messages;
    runtime.messageSourceLabel = result.label;
    runtime.firstMessageRecord = result.firstRecord;

    runtime.messageIndex = new Map();
    for (const message of runtime.messages) {
        const list = runtime.messageIndex.get(message.deviceId) || [];
        list.push(message);
        runtime.messageIndex.set(message.deviceId, list);
    }

    if (runtime.messageDeviceFilter && !runtime.deviceById.has(runtime.messageDeviceFilter)) {
        runtime.messageDeviceFilter = "";
    }
}

/** Flatten a messages node into [id, record] pairs. */
function messagePairs(data) {
    if (!data || typeof data !== "object") return [];

    if (Array.isArray(data)) {
        return data
            .map((entry, index) => [String(index), entry])
            .filter(([, entry]) => entry && typeof entry === "object");
    }

    const values = Object.values(data);
    const looksLikeRecord =
        values.length > 0 &&
        values.every((value) => value === null || typeof value !== "object");
    if (looksLikeRecord && ("body" in data || "message" in data || "text" in data)) {
        return [["0", data]];
    }
    return Object.entries(data).filter(([, value]) => value && typeof value === "object");
}

function matchDeviceByAddress(raw) {
    const address = raw?.from || raw?.sender || raw?.address || raw?.to || "";
    if (!address) return "";
    for (const device of runtime.devices) {
        if (!device.phoneNumber) continue;
        if (sameNumber(address, device.phoneNumber)) return device.id;
    }
    return "";
}

/* ==================================================================== *
 * Views
 * ==================================================================== */

function renderEverything() {
    renderStats();
    renderSidebar();
    renderDevices();
    renderMessages();
    renderDatabases();
    renderLayoutDetails();
    renderMessageDeviceFilter();
    renderLookupPreview();
    renderLookupToggle();
}

function renderStats() {
    const devices = runtime.devices;
    $("activeClientsCount").textContent = String(devices.filter((d) => d.status === "online").length);
    $("totalClientsCount").textContent = String(devices.length);
    $("totalSMSCount").textContent = String(runtime.messages.length);
    $("totalSimCount").textContent = String(
        devices.reduce((sum, device) => sum + device.sims.length, 0),
    );
    $("visibleClientsCount").textContent = String(filteredDevices().length);
}

function filteredDevices() {
    return runtime.devices.filter((device) => {
        if (runtime.statusFilter !== "all" && device.status !== runtime.statusFilter) {
            return false;
        }
        if (!deviceMatches(device, runtime.deviceQuery)) return false;
        if (runtime.panelQuery && !deviceMatches(device, runtime.panelQuery)) return false;
        return true;
    });
}

function statusPill(device) {
    const map = {
        online: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        offline: "border-slate-700 bg-slate-900 text-slate-500",
        unknown: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    };
    return `<span class="status-pill ${map[device.status]} text-[8px] px-1.5 py-0.5">${esc(
        device.status,
    )}</span>`;
}

function batteryMarkup(device) {
    if (device.battery === null || device.battery === undefined) {
        return `<span class="battery-missing">battery —</span>`;
    }
    const level = device.battery;
    const cls = level <= 15 ? "critical" : level <= 35 ? "low" : "";
    return `<span class="client-battery">
        <span>${level}%</span>
        <span class="battery-bar"><span class="battery-fill ${cls}" style="width:${level}%"></span></span>
    </span>`;
}

function renderDevices() {
    const container = $("clientsContainer");
    const devices = filteredDevices();

    if (!runtime.connected) {
        container.innerHTML = `<div class="status-placeholder">Connect a database to sync hardware profiles.</div>`;
        return;
    }
    if (!runtime.devices.length) {
        container.innerHTML = `<div class="status-placeholder">No device records were recognised in this database.</div>`;
        return;
    }
    if (!devices.length) {
        container.innerHTML = `<div class="status-placeholder">No hardware target matches the current filters.</div>`;
        return;
    }

    container.innerHTML = devices
        .map((device) => {
            const messageCount = runtime.messageIndex.get(device.id)?.length || 0;
            const simChips = device.sims.length
                ? device.sims
                      .map(
                          (sim) =>
                              `<span class="chip" title="${esc(sim.carrier || "SIM")} ${esc(
                                  sim.iccid || "",
                              )}">${esc(sim.number || sim.carrier || `SIM ${sim.slot ?? "?"}`)}</span>`,
                      )
                      .join(" ")
                : `<span class="chip chip-idle">no sim data</span>`;

            return `
            <article class="client-card client-interactive-card" data-device="${esc(device.id)}">
                <div class="client-head">
                    <div class="min-w-0">
                        <div class="client-title">${esc(device.id)}</div>
                        <span class="client-subtitle">${esc(device.modelName || "unknown model")}</span>
                    </div>
                    ${statusPill(device)}
                </div>
                <div class="client-grid">
                    <span><b>phone</b> ${esc(device.phoneNumber || "—")}</span>
                    <span><b>carrier</b> ${esc(device.operator || "—")}</span>
                    <span><b>android</b> ${esc(device.androidV || "—")}</span>
                    <span><b>ip</b> ${esc(device.ip || "—")}</span>
                </div>
                <div class="flex flex-wrap gap-1">${simChips}</div>
                ${batteryMarkup(device)}
                <div class="client-foot">
                    <span>seen ${esc(relativeTime(device.lastSeen))}</span>
                    <span>${messageCount} msg</span>
                </div>
                <div class="card-actions">
                    <button type="button" class="card-btn" data-logs="${esc(device.id)}">
                        <span class="material-icons">forum</span>Logs
                    </button>
                    ${
                        store.lookupEnabled
                            ? `<button type="button" class="card-btn card-btn-lookup" data-lookup="${esc(
                                  device.id,
                              )}" ${device.phoneNumber ? "" : "disabled title=\"No number recorded\""}>
                                   <span class="material-icons">travel_explore</span>Lookup
                               </button>`
                            : ""
                    }
                </div>
            </article>`;
        })
        .join("");
}

function renderSidebar() {
    const container = $("deviceTabsListContainer");
    const devices = filteredDevices();

    if (!runtime.devices.length) {
        container.innerHTML = `<div class="text-xs text-slate-600 text-center py-6 font-mono">No devices loaded.</div>`;
        return;
    }
    if (!devices.length) {
        container.innerHTML = `<div class="text-xs text-slate-600 text-center py-6 font-mono">No match.</div>`;
        return;
    }

    container.innerHTML = devices
        .map(
            (device) => `
        <button type="button" class="sidebar-device ${
            runtime.selectedDeviceId === device.id ? "sidebar-device-active" : ""
        }" data-select="${esc(device.id)}">
            <span class="sd-dot status-dot-${esc(device.status)}"></span>
            <span class="min-w-0 flex-1">
                <span class="sd-id">${esc(device.id)}</span>
                <span class="sd-meta">${esc(device.phoneNumber || device.modelName || "no number")}</span>
            </span>
        </button>`,
        )
        .join("");
}

function renderMessageDeviceFilter() {
    const select = $("messageDeviceFilter");
    const ids = [...runtime.messageIndex.keys()].sort();
    const current = runtime.messageDeviceFilter;

    select.innerHTML =
        `<option value="">All devices (${runtime.messages.length})</option>` +
        ids
            .map((id) => {
                const count = runtime.messageIndex.get(id).length;
                const label = id === "unassigned" ? "Unassigned" : id;
                return `<option value="${esc(id)}" ${current === id ? "selected" : ""}>${esc(
                    label,
                )} (${count})</option>`;
            })
            .join("");
}

function visibleMessages() {
    let list = runtime.messages;
    if (runtime.messageDeviceFilter) {
        list = list.filter((message) => message.deviceId === runtime.messageDeviceFilter);
    }
    if (runtime.messageDirectionFilter !== "all") {
        list = list.filter((message) => message.direction === runtime.messageDirectionFilter);
    }
    if (runtime.panelQuery) {
        list = list.filter(
            (message) => messageMatches(message, runtime.panelQuery) || message.deviceId.includes(runtime.panelQuery),
        );
    }
    return list;
}

function renderMessages() {
    const container = $("smsMessagesContainer");
    const label = $("activeDeviceFilterLabel");
    const filterDevice = runtime.selectedDeviceId || runtime.messageDeviceFilter;

    label.textContent = filterDevice
        ? filterDevice === "unassigned"
            ? "Unassigned"
            : filterDevice
        : "All Devices";
    label.title = runtime.messageSourceLabel ? `source: ${runtime.messageSourceLabel}` : "";

    if (!runtime.connected) {
        container.innerHTML = `<div class="status-placeholder">Connect a database to sync message logs.</div>`;
        return;
    }

    const list = visibleMessages();
    if (!runtime.messages.length) {
        container.innerHTML = `<div class="status-placeholder">No message node was found in this database.<br>The feed stays empty when the database does not store SMS.</div>`;
        return;
    }
    if (!list.length) {
        container.innerHTML = `<div class="status-placeholder">No message matches the current filters.</div>`;
        return;
    }

    container.innerHTML = list
        .map((message) => {
            const peer = message.direction === "in" ? message.from : message.to;
            const when = message.ts ? relativeTime(message.ts) : "no timestamp";
            const exact = message.ts ? formatTimestamp(message.ts) : "no timestamp";
            return `
            <article class="sms-row sms-${esc(message.direction)}">
                <div class="sms-head">
                    <span class="sms-peer">
                        <span class="sms-tag sms-tag-${esc(message.direction)}">${
                            message.direction === "in" ? "IN" : "OUT"
                        }</span>
                        <span>${esc(peer || "unknown")}</span>
                    </span>
                    <span class="sms-time" title="${esc(exact)}">${esc(when)}</span>
                </div>
                <div class="sms-body${message.body ? "" : " sms-body-empty"}">${esc(
                    message.body || "(empty message)",
                )}</div>
                <div class="sms-actions">
                    <span class="text-[8.5px] font-mono text-slate-600 uppercase">${
                        message.deviceId === "unassigned" ? "unassigned" : esc(message.deviceId)
                    }</span>
                    <button type="button" class="sms-link" data-copy-text="${esc(message.body || "")}">copy</button>
                    ${
                        message.deviceId !== "unassigned"
                            ? `<button type="button" class="sms-link" data-open-device="${esc(
                                  message.deviceId,
                              )}">device</button>`
                            : ""
                    }
                </div>
            </article>`;
        })
        .join("");
}

function renderDatabases() {
    const itemMarkup = (entry) => {
        const active = entry.url === runtime.activeUrl;
        return `
        <div class="db-row ${active ? "db-row-active" : ""}">
            <div class="db-row-info">
                <div class="db-row-name">${esc(entry.label || databaseLabel(entry.url))}</div>
                <div class="db-row-url">${esc(entry.url)}</div>
            </div>
            <div class="db-row-actions">
                <button type="button" class="db-action-mini ${active ? "db-action-active" : ""}" data-db-use="${esc(
                    entry.url,
                )}">${active ? "active" : "use"}</button>
                <button type="button" class="db-action-mini db-action-danger" data-db-remove="${esc(
                    entry.url,
                )}">×</button>
            </div>
        </div>`;
    };

    const html = store.databases.length
        ? store.databases.map(itemMarkup).join("")
        : `<div class="status-placeholder">None saved yet.</div>`;

    for (const id of ["dbListContainer", "dbListContainer2"]) {
        const node = $(id);
        if (node) node.innerHTML = html;
    }
}

/** Populate the layout override dropdown and show the detection evidence. */
function renderSchemaOptions() {
    const select = $("schemaOverrideSelect");
    if (!select) return;

    const current = Number.isInteger(store.schemaOverride) ? String(store.schemaOverride) : "auto";
    const options = ['<option value="auto">Auto-detect</option>']
        .concat(
            Object.keys(SCHEMA_NAMES).map(
                (key) => `<option value="${esc(key)}">${esc(SCHEMA_NAMES[key])}</option>`,
            ),
        )
        .join("");
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = current;

    const evidence = $("schemaEvidence");
    if (evidence) {
        evidence.textContent = runtime.detectedSchema
            ? `Auto-detect: ${schemaName(runtime.detectedSchema)} — ${runtime.schemaEvidence.join(" · ")}`
            : "Connect a database to see the detection evidence.";
    }
}

function renderLayoutDetails() {
    const node = $("layoutDetails");
    if (!node) return;
    node.textContent = runtime.layout
        ? [
              `layout        : ${schemaName(
                  effectiveSchema(store.schemaOverride, runtime.detectedSchema || 1),
              )}${Number.isInteger(store.schemaOverride) ? " (manual)" : " (auto)"}`,
              `evidence      : ${runtime.schemaEvidence.join(" · ") || "—"}`,
              `root keys     : ${runtime.layout.rootKeys.join(", ") || "—"}`,
              `device node   : ${runtime.layout.clientsPath || "not detected"}`,
              `sim sidecar   : ${runtime.layout.simsPath || "—"}${runtime.layout.simsNode ? " (loaded)" : ""}`,
              `message node  : ${runtime.messageSourceLabel || "not found"}`,
              `messages read : ${runtime.messages.length}`,
              `command node  : ${runtime.commandPath || "none"} (read-only, never written)`,
              `skipped nodes : ${runtime.layout.skipped.length ? runtime.layout.skipped.join(", ") : "none"}`,
          ].join("\n")
        : "Connect a database to inspect its structure.";

    renderSchemaOptions();
}

/* ---------------------------- device sheet -------------------------- */

function openDevice(deviceId) {
    const device = runtime.deviceById.get(deviceId);
    if (!device) return;

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
        ["Messages", String(runtime.messageIndex.get(device.id)?.length || 0)],
    ];

    const sims = device.sims.length
        ? device.sims
              .map(
                  (sim) => `
            <div class="sim-block">
                <div class="sim-block-title">SIM slot ${esc(sim.slot ?? "?")}</div>
                <div class="kv-row"><span class="kv-key">Number</span><span class="kv-val">${esc(sim.number || "—")}</span></div>
                <div class="kv-row"><span class="kv-key">Carrier</span><span class="kv-val">${esc(sim.carrier || "—")}</span></div>
                <div class="kv-row"><span class="kv-key">ICCID</span><span class="kv-val">${esc(sim.iccid || "—")}</span></div>
                ${sim.type ? `<div class="kv-row"><span class="kv-key">Type</span><span class="kv-val">${esc(sim.type)}</span></div>` : ""}
            </div>`,
              )
              .join("")
        : `<div class="result-empty">No SIM details recorded.</div>`;

    $("deviceModalContent").innerHTML = `
        ${rows
            .map(
                ([key, value]) =>
                    `<div class="kv-row"><span class="kv-key">${esc(key)}</span><span class="kv-val">${esc(value)}</span></div>`,
            )
            .join("")}
        <div class="pt-1"><h3 class="section-title px-1">SIM Slots</h3></div>
        ${sims}
        <div class="card-actions pt-1">
            <button type="button" class="card-btn" data-logs="${esc(device.id)}">
                <span class="material-icons">forum</span>Open log feed
            </button>
            <button type="button" class="card-btn card-btn-lookup" data-lookup="${esc(device.id)}">
                <span class="material-icons">travel_explore</span>Lookup number
            </button>
            <button type="button" class="card-btn" data-copy-text="${esc(device.id)}">
                <span class="material-icons">content_copy</span>Copy ID
            </button>
        </div>
        <details class="bg-slate-950/60 border border-slate-900 rounded-xl p-2">
            <summary class="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-wider cursor-pointer">Raw record</summary>
            <pre class="code-block mt-2">${esc(JSON.stringify(device.raw, null, 2))}</pre>
        </details>`;

    openModal("deviceModal");
}

/* ---------------------------- per-device lookup ---------------------- */

async function lookupForDevice(deviceId) {
    const device = runtime.deviceById.get(deviceId);
    if (!device) return;
    if (!device.phoneNumber) {
        toast("This device has no phone number recorded.", "error");
        return;
    }

    $("deviceLookupSub").textContent = `${device.id} · ${device.phoneNumber}`;
    $("deviceLookupContent").innerHTML = `<div class="result-empty">Checking ${esc(
        device.phoneNumber,
    )}…</div>`;
    openModal("deviceLookupModal");

    try {
        const result = await checkMobile(device.phoneNumber, {
            endpoint: $("lookupEndpoint").value.trim() || DEFAULT_LOOKUP_ENDPOINT,
            token: $("lookupToken").value.trim(),
            initData: $("lookupInitData").value,
        });
        $("deviceLookupContent").innerHTML = renderLookupBody(result);
    } catch (error) {
        const message = error instanceof LookupError ? error.message : "The lookup failed.";
        $("deviceLookupContent").innerHTML = `<div class="notice-error text-[10px] font-mono leading-relaxed rounded-xl border px-3 py-2">${esc(
            message,
        )}</div>`;
    }
}

function renderLookupBody(result) {
    const flat = flattenResult(result.data);
    const rows = flat.length
        ? flat
              .map(
                  ([key, value]) =>
                      `<div class="kv-row"><span class="kv-key">${esc(key)}</span><span class="kv-val">${esc(
                          value === null || value === undefined ? "null" : String(value),
                      )}</span></div>`,
              )
              .join("")
        : `<div class="result-empty">The endpoint returned an empty payload.</div>`;

    return `
        <div class="flex items-center justify-between">
            <span class="section-title">Result</span>
            <span class="text-[8px] font-mono text-slate-600">HTTP ${result.status} · ${result.ms} ms</span>
        </div>
        ${rows}
        <details class="bg-slate-950/60 border border-slate-900 rounded-xl p-2">
            <summary class="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-wider cursor-pointer">Raw response</summary>
            <pre class="code-block mt-2">${esc(
                typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2),
            )}</pre>
        </details>`;
}

/* ------------------------------ lookup tab -------------------------- */

function renderLookupToggle() {
    $("lookupToggleBtn").setAttribute("aria-pressed", String(store.lookupEnabled));
}

function renderLookupPreview() {
    const endpoint = $("lookupEndpoint").value.trim() || DEFAULT_LOOKUP_ENDPOINT;
    const token = $("lookupToken").value.trim() || "<token>";
    const mobile = $("lookupMobile").value.trim() || "<mobile>";
    const initData = $("lookupInitData").value;
    const preview = $("lookupPreview");
    if (!preview) return;
    preview.textContent = `POST ${endpoint}\nx-token: ${token}\n\n${JSON.stringify(
        { mobile, token, initData },
        null,
        2,
    )}`;
}

function setLookupStatus(message, kind = "info") {
    const node = $("lookupStatus");
    if (!message) {
        node.className = "hidden";
        node.textContent = "";
        return;
    }
    node.className = `notice-${kind} text-[10px] font-mono leading-relaxed rounded-xl border px-3 py-2`;
    node.textContent = message;
}

async function submitLookup(event) {
    event?.preventDefault();
    const mobile = $("lookupMobile").value.trim();
    const endpoint = $("lookupEndpoint").value.trim() || DEFAULT_LOOKUP_ENDPOINT;
    const token = $("lookupToken").value.trim();
    const initData = $("lookupInitData").value;

    hide("lookupResult");
    $("lookupSubmit").disabled = true;
    setLookupStatus("Checking…", "info");

    try {
        const result = await checkMobile(mobile, { endpoint, token, initData });
        setLookupStatus(`Done in ${result.ms} ms (HTTP ${result.status}).`, "success");
        const node = $("lookupResult");
        node.innerHTML = renderLookupBody(result);
        node.classList.remove("hidden");
    } catch (error) {
        setLookupStatus(
            error instanceof LookupError ? error.message : "The lookup failed unexpectedly.",
            "error",
        );
    } finally {
        $("lookupSubmit").disabled = false;
    }
}

/* ---------------------------- global search ------------------------- */

function renderGlobalSearch(query) {
    const container = $("globalSearchResults");
    const count = $("globalSearchCount");
    const q = query.trim();

    if (!q) {
        container.innerHTML = `<div class="text-[10px] font-mono text-slate-600 text-center py-8">Type to search across every device and message in this database.</div>`;
        count.textContent = "0 results";
        return;
    }

    const devices = runtime.devices.filter((device) => deviceMatches(device, q)).slice(0, 20);
    const messages = runtime.messages.filter((message) => messageMatches(message, q)).slice(0, 20);

    const deviceBlock = devices.length
        ? `<div class="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-wider px-1 pt-1">Devices (${devices.length})</div>` +
          devices
              .map(
                  (device) => `
            <button type="button" class="sidebar-device" data-select="${esc(device.id)}">
                <span class="sd-dot status-dot-${esc(device.status)}"></span>
                <span class="min-w-0 flex-1">
                    <span class="sd-id">${esc(device.id)}</span>
                    <span class="sd-meta">${esc(device.modelName || "unknown")} · ${esc(
                        device.phoneNumber || "no number",
                    )} · ${esc(device.status)}</span>
                </span>
            </button>`,
              )
              .join("")
        : "";

    const messageBlock = messages.length
        ? `<div class="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-wider px-1 pt-2">Messages (${messages.length})</div>` +
          messages
              .map(
                  (message) => `
            <button type="button" class="sidebar-device" data-logs="${esc(message.deviceId)}">
                <span class="min-w-0 flex-1">
                    <span class="sd-id">${esc(message.direction === "in" ? message.from : message.to) || "unknown"}</span>
                    <span class="sd-meta">${esc((message.body || "(empty)").slice(0, 70))}</span>
                    <span class="sd-meta">${esc(message.deviceId)} · ${esc(
                        message.ts ? relativeTime(message.ts) : "no timestamp",
                    )}</span>
                </span>
            </button>`,
              )
              .join("")
        : "";

    container.innerHTML =
        deviceBlock + messageBlock ||
        `<div class="text-[10px] font-mono text-slate-600 text-center py-8">Nothing matched “${esc(q)}”.</div>`;
    const total = devices.length + messages.length;
    count.textContent = `${total} result${total === 1 ? "" : "s"}`;
}

/* ==================================================================== *
 * Navigation / tabs
 * ==================================================================== */

const TAB_IDS = ["clients", "messages", "lookup", "data"];

function switchTab(tab) {
    runtime.tab = tab;
    for (const name of TAB_IDS) {
        const panel = $(`tabContent-${name}`);
        if (panel) panel.classList.toggle("hidden", name !== tab);
        const btn = $(`bottomTabBtn-${name}`);
        if (btn) {
            btn.classList.toggle("bottom-nav-active", name === tab);
            btn.classList.toggle("bottom-nav-inactive", name !== tab);
        }
    }
    if (tab === "messages") renderMessages();
}

function openLogs(deviceId) {
    runtime.selectedDeviceId = deviceId && runtime.deviceById.has(deviceId) ? deviceId : "";
    runtime.messageDeviceFilter = runtime.selectedDeviceId;
    $("messageDeviceFilter").value = runtime.messageDeviceFilter;
    switchTab("messages");
    renderMessages();
    renderSidebar();
    closeModal("deviceModal");
    closeModal("globalSearchModal");
}

/* ==================================================================== *
 * Databases
 * ==================================================================== */

function addDatabase(url, label) {
    const normalized = normalizeDatabaseUrl(url);
    if (!normalized) {
        setDbFeedback("That does not look like a database URL.", true);
        return null;
    }
    const existing = store.databases.find((entry) => entry.url === normalized);
    if (existing) {
        if (label) existing.label = label;
    } else {
        store.databases.push({ url: normalized, label: label || "", addedAt: Date.now() });
    }
    saveStore();
    renderDatabases();
    return normalized;
}

function setDbFeedback(message, isError = false) {
    for (const id of ["dbAddFeedback", "dbAddFeedback2"]) {
        const node = $(id);
        if (!node) continue;
        if (!message) {
            node.classList.add("hidden");
            node.textContent = "";
            continue;
        }
        node.classList.remove("hidden");
        node.textContent = message;
        node.className = `text-[9px] font-mono ${isError ? "text-rose-400" : "text-slate-400"}`;
    }
}

function removeDatabase(url) {
    store.databases = store.databases.filter((entry) => entry.url !== url);
    if (store.activeUrl === url) {
        store.activeUrl = "";
        runtime.connection = null;
        runtime.connected = false;
        runtime.devices = [];
        runtime.messages = [];
        runtime.deviceById.clear();
        runtime.messageIndex.clear();
        updateDbHeader("");
        setConnectionPill("idle", "IDLE");
        setLoadStatus("Disconnected.");
        runtime.detectedSchema = 0;
        runtime.schemaEvidence = [];
        renderSchemaBadge();
        setProgress(0);
    }
    saveStore();
    renderEverything();
}

/* ==================================================================== *
 * Wiring
 * ==================================================================== */

function closeAllModals() {
    for (const id of [
        "dbManagerModal",
        "deviceModal",
        "deviceLookupModal",
        "globalSearchModal",
    ]) {
        closeModal(id);
    }
}

function wire() {
    // tabs
    for (const name of TAB_IDS) {
        $(`bottomTabBtn-${name}`)?.addEventListener("click", () => switchTab(name));
    }

    // header
    $("lookupToggleBtn").addEventListener("click", () => {
        store.lookupEnabled = !store.lookupEnabled;
        saveStore();
        renderLookupToggle();
        renderDevices();
        toast(
            store.lookupEnabled
                ? "Lookup buttons enabled on device cards."
                : "Lookup buttons hidden from device cards.",
            "success",
            2000,
        );
    });
    $("globalSearchBtn").addEventListener("click", () => {
        $("globalSearchInput").value = "";
        renderGlobalSearch("");
        openModal("globalSearchModal");
        $("globalSearchInput").focus();
    });
    $("openDbManagerBtn").addEventListener("click", () => {
        renderDatabases();
        openModal("dbManagerModal");
    });
    $("exportDataBtn").addEventListener("click", () => {
        if (!runtime.connected) return toast("Connect a database first.", "error");
        const payload = {
            database: runtime.activeUrl,
            exportedAt: new Date().toISOString(),
            layout: runtime.layout
                ? {
                      schema: schemaName(runtime.detectedSchema || 1),
                      schemaDetected: runtime.detectedSchema,
                      schemaOverride: store.schemaOverride,
                      evidence: runtime.schemaEvidence,
                      devicePath: runtime.layout.clientsPath,
                      simSidecar: runtime.layout.simsPath,
                      messageNode: runtime.messageSourceLabel,
                      rootKeys: runtime.layout.rootKeys,
                  }
                : null,
            devices: runtime.devices.map((device) => ({ ...device, raw: device.raw })),
            messages: runtime.messages.map((message) => ({
                deviceId: message.deviceId,
                direction: message.direction,
                from: message.from,
                to: message.to,
                body: message.body,
                ts: message.ts,
            })),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `firebase-manager-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        toast("Export downloaded.", "success", 2000);
    });

    // filters
    $("deviceSearchInput").addEventListener("input", (event) => {
        runtime.deviceQuery = event.target.value;
        renderDevices();
        renderSidebar();
        renderStats();
    });
    $("panelSearchInput").addEventListener("input", (event) => {
        runtime.panelQuery = event.target.value;
        renderDevices();
        renderSidebar();
        renderStats();
        renderMessages();
    });
    for (const status of ["all", "online", "offline"]) {
        $(`statusFilterBtn-${status}`).addEventListener("click", () => {
            runtime.statusFilter = status;
            for (const other of ["all", "online", "offline"]) {
                const btn = $(`statusFilterBtn-${other}`);
                btn.className = `subtab-pill ${
                    other === status ? "subtab-pill-active" : "subtab-pill-inactive"
                }`;
            }
            renderDevices();
            renderSidebar();
            renderStats();
        });
    }

    // drawer
    const openDrawer = () => {
        $("deviceSidebarSection").classList.remove("-translate-x-full");
        $("drawerBackdropOverlay").classList.remove("hidden");
    };
    const closeDrawer = () => {
        $("deviceSidebarSection").classList.add("-translate-x-full");
        $("drawerBackdropOverlay").classList.add("hidden");
    };
    $("menuDrawerToggleBtn").addEventListener("click", openDrawer);
    $("closeDrawerBtn").addEventListener("click", closeDrawer);
    $("drawerBackdropOverlay").addEventListener("click", closeDrawer);

    // reload / message sync
    $("reloadDataBtn").addEventListener("click", async () => {
        if (!runtime.activeUrl) return toast("Add a database first.", "error");
        await connect(runtime.activeUrl);
    });
    $("refreshMessagesBtn").addEventListener("click", async () => {
        if (!runtime.connected) return toast("Connect a database first.", "error");
        $("refreshMessagesBtn").disabled = true;
        setLoadStatus("Re-syncing message logs…");
        try {
            await loadMessages({ force: true });
            renderMessages();
            renderMessageDeviceFilter();
            renderStats();
            $("smsLastSyncLabel").textContent = `synced ${relativeTime(Date.now())}`;
            setLoadStatus(`Synced · ${runtime.devices.length} devices · ${runtime.messages.length} messages`);
            toast(`${runtime.messages.length} message(s) loaded.`, "success", 2200);
        } catch (error) {
            toast(error?.message || "Message sync failed.", "error");
        } finally {
            $("refreshMessagesBtn").disabled = false;
        }
    });

    // message filters
    $("messageDeviceFilter").addEventListener("change", (event) => {
        runtime.messageDeviceFilter = event.target.value;
        runtime.selectedDeviceId = event.target.value;
        renderMessages();
        renderSidebar();
    });
    $("messageDirectionFilter").addEventListener("change", (event) => {
        runtime.messageDirectionFilter = event.target.value;
        renderMessages();
    });

    // lookup tab
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
        toast("Lookup settings saved in this browser.", "success", 2200);
    });

    $("schemaOverrideSelect").addEventListener("change", async (event) => {
        const value = event.target.value;
        store.schemaOverride = value === "auto" ? null : Number.parseInt(value, 10);
        if (!Number.isInteger(store.schemaOverride)) store.schemaOverride = null;
        saveStore();
        renderSchemaBadge();
        toast(
            store.schemaOverride === null
                ? "Schema override cleared — auto-detect active."
                : `Layout forced to ${schemaName(store.schemaOverride)} — reloading.`,
            "info",
            2600,
        );
        if (runtime.activeUrl) await connect(runtime.activeUrl);
        renderSchemaOptions();
    });

    // database forms (bottom tab + modal)
    const addFrom = (urlId, labelId) => {
        const url = $(urlId).value.trim();
        const label = $(labelId).value.trim();
        const normalized = addDatabase(url, label);
        if (!normalized) return;
        $(urlId).value = "";
        $(labelId).value = "";
        setDbFeedback("");
        closeModal("dbManagerModal");
        switchTab("clients");
        connect(normalized);
    };
    $("dbAddBtn").addEventListener("click", () => addFrom("dbUrlInput2", "dbLabelInput2"));
    $("dbAddBtn2").addEventListener("click", () => addFrom("dbUrlInput", "dbLabelInput"));

    // delegated clicks on lists / cards
    document.addEventListener("click", (event) => {
        const target = event.target.closest("[data-device], [data-select], [data-logs], [data-lookup]");
        if (!target) return;

        if (target.dataset.copyText !== undefined) return;

        if (target.dataset.lookup) {
            event.stopPropagation();
            lookupForDevice(target.dataset.lookup);
            return;
        }
        if (target.dataset.logs) {
            event.stopPropagation();
            openLogs(target.dataset.logs);
            return;
        }
        if (target.dataset.select) {
            const id = target.dataset.select;
            openLogs(id);
            if (window.innerWidth < 768) closeDrawer();
            return;
        }
        if (target.dataset.device) {
            openDevice(target.dataset.device);
        }
    });

    document.addEventListener("click", (event) => {
        const copy = event.target.closest("[data-copy-text]");
        if (copy) {
            event.stopPropagation();
            const value = copy.getAttribute("data-copy-text");
            copyText(value, "Copied");
            return;
        }
        const openDeviceBtn = event.target.closest("[data-open-device]");
        if (openDeviceBtn) openDevice(openDeviceBtn.dataset.openDevice);
    });

    // database list actions
    for (const id of ["dbListContainer", "dbListContainer2"]) {
        $(id).addEventListener("click", async (event) => {
            const use = event.target.closest("[data-db-use]");
            if (use) {
                closeModal("dbManagerModal");
                switchTab("clients");
                await connect(use.dataset.dbUse);
                return;
            }
            const remove = event.target.closest("[data-db-remove]");
            if (remove) removeDatabase(remove.dataset.dbRemove);
        });
    }

    // modals
    $("closeDbManagerBtn").addEventListener("click", () => closeModal("dbManagerModal"));
    $("dbManagerBackdrop").addEventListener("click", () => closeModal("dbManagerModal"));
    $("closeDeviceModalBtn").addEventListener("click", () => closeModal("deviceModal"));
    $("deviceModalBackdrop").addEventListener("click", () => closeModal("deviceModal"));
    $("closeDeviceLookupBtn").addEventListener("click", () => closeModal("deviceLookupModal"));
    $("deviceLookupBackdrop").addEventListener("click", () => closeModal("deviceLookupModal"));
    $("closeGlobalSearchBtn").addEventListener("click", () => closeModal("globalSearchModal"));
    $("globalSearchBackdrop").addEventListener("click", () => closeModal("globalSearchModal"));

    $("globalSearchInput").addEventListener("input", (event) =>
        renderGlobalSearch(event.target.value),
    );

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeAllModals();
    });

    $("globalSearchResults").addEventListener("click", () => closeModal("globalSearchModal"));
}

/* ==================================================================== *
 * Boot
 * ==================================================================== */

function boot() {
    wire();

    $("lookupEndpoint").value = store.lookup.endpoint || DEFAULT_LOOKUP_ENDPOINT;
    $("lookupToken").value = store.lookup.token || "";
    $("lookupInitData").value = store.lookup.initData || "";

    renderEverything();
    switchTab("clients");
    setConnectionPill("idle", "IDLE");
    setLoadStatus("No database connected.");

    const requested = new URLSearchParams(location.search).get("db");
    const initial = requested ? normalizeDatabaseUrl(requested) : store.activeUrl;

    if (initial) {
        if (requested && !store.databases.some((entry) => entry.url === initial)) {
            addDatabase(initial, "");
        }
        updateDbHeader(initial);
        connect(initial, { silent: true });
    } else {
        updateDbHeader("");
        openModal("dbManagerModal");
    }
}

boot();
