/**
 * Pure helpers: URL parsing, layout detection, record normalisation.
 *
 * Nothing in this file touches the DOM or the network, so every function here
 * is unit-testable under plain `node --test`. The UI layer (app.js) and the
 * REST client (lib/db.js) both consume these helpers.
 */

/* ------------------------------------------------------------------ *
 * Values that devices publish when a SIM slot is empty. They are not  *
 * phone numbers and must never be rendered as one.                    *
 * ------------------------------------------------------------------ */

const DEAD_VALUES = new Set([
  "no sim found", "no sim", "no data", "not available", "not availabe",
  "unknown", "null", "none", "nil", "undefined", "n/a", "na", "-",
  "--", "0", "",
]);

export function isDeadValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return value === 0;
  const s = String(value).trim().toLowerCase();
  return DEAD_VALUES.has(s);
}

/** Trimmed string, or "" for null/undefined/dead values. */
export function cleanString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  const s = String(value).trim();
  return isDeadValue(s) ? "" : s;
}

/* ------------------------------------------------------------------ *
 * Database URLs                                                       *
 * ------------------------------------------------------------------ */

/**
 * Parse user input into { base, auth }. Accepts a bare host
 * (`x-default-rtdb.firebaseio.com`), a full URL, or one carrying `?auth=`
 * / `?key=`. Returns null when the input is not a usable http(s) URL.
 */
export function parseDatabaseUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || !url.hostname.includes(".")) return null;

  const auth =
    url.searchParams.get("auth") || url.searchParams.get("key") || "";
  const base = (url.origin + url.pathname).replace(/\/+$/, "");
  return { base, auth };
}

/** Canonical display/storage form of a database URL. "" when unusable. */
export function normalizeDatabaseUrl(input) {
  const parsed = parseDatabaseUrl(input);
  if (!parsed) return "";
  return parsed.auth
    ? `${parsed.base}?auth=${encodeURIComponent(parsed.auth)}`
    : parsed.base;
}

/** Short host label for the header pill. */
export function databaseLabel(input) {
  const parsed = parseDatabaseUrl(input);
  if (!parsed) return "not connected";
  try {
    return new URL(parsed.base).hostname;
  } catch {
    return parsed.base;
  }
}

/**
 * Build a REST URL for a path. `path` may be "", "/", "clients", "a/b".
 * `params` are appended as query parameters, skipping empty values.
 */
export function restUrl(base, path = "", params = {}) {
  const trimmedBase = String(base || "").replace(/\/+$/, "");
  const clean = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
  const url = clean ? `${trimmedBase}/${clean}.json` : `${trimmedBase}/.json`;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) {
      continue;
    }
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${url}?${query}` : url;
}

/* ------------------------------------------------------------------ *
 * Layout detection                                                    *
 * ------------------------------------------------------------------ */

/** Root children that are configuration/queues, never device lists. */
const RESERVED_ROOT_KEYS = new Set([
  "messages", "message", "sms", "chats", "commands", "device_commands",
  "smsqueue", "sms_queue", "queues", "bot_users", "bots", "sms_forward",
  "smsforward", "guard", "licenses", "licence", "license", "_comments",
  "comments", "links", "proxies", "proxy", "admins", "admin", "config",
  "settings", "logs", "notifications", "stats", "meta", "server", "servers",
  "user_sms", "user_msgs", "usermessages", "user_messages", "sms_store",
  "app_settings", "broadcast", "announcements", "prices", "price", "plans",
]);

const CONTAINER_CHILD_NAMES = new Set([
  "info", "data", "deviceinfo", "device_info", "devices", "clients", "users",
]);

/**
 * Ordered list of device-node candidates, most specific first.
 *
 * @param {string[]} rootKeys  keys returned by a shallow read of "/"
 * @param {Record<string,string[]>} childKeysByNode  optional shallow reads
 *        of top-level nodes, e.g. { All_User: ["Info","Data"] }
 */
export function buildCandidatePaths(rootKeys, childKeysByNode = {}) {
  const present = new Set((rootKeys || []).map((k) => String(k)));
  const out = [];
  const push = (path) => {
    if (!out.includes(path)) out.push(path);
  };

  // Nested containers first (All_User/Info etc.).
  for (const parent of ["All_User", "All_Users", "user", "root", "panel"]) {
    if (!present.has(parent)) continue;
    const children = childKeysByNode[parent] || [];
    for (const child of children) {
      if (CONTAINER_CHILD_NAMES.has(String(child).toLowerCase())) {
        push(`${parent}/${child}`);
      }
    }
  }

  // Then the well-known flat nodes, including the `user_data` layout where
  // `clients` / `devices` exist only as ping decoys.
  for (const key of [
    "user_data", "userdata", "Info", "Data", "DeviceInfo", "clients",
    "devices", "users", "accounts", "customers", "subscribers",
  ]) {
    if (present.has(key)) push(key);
  }

  // Finally any remaining root node that is not reserved config/queue data.
  for (const key of present) {
    if (RESERVED_ROOT_KEYS.has(key.toLowerCase())) continue;
    if (out.some((p) => p.split("/")[0] === key)) continue;
    if (childKeysByNode[key] && childKeysByNode[key].length > 0) continue;
    push(key);
  }

  return out;
}

/** Fields whose presence means "this is a real device record". */
const DEVICE_SIGNAL_FIELDS = [
  "model", "devicename", "device_model", "device_info", "d_name",
  "battery", "batt", "charge", "status", "lastseen", "last_seen",
  "sim", "sims", "number", "phonenumber", "mobno", "operator",
  "carrier", "android", "androidv", "installtime", "joined",
];

/** True when every supplied record contains `ping` as its only field. */
export function isPingOnly(records) {
  const list = (records || []).filter(
    (r) => r && typeof r === "object" && !Array.isArray(r),
  );
  if (list.length === 0) return false;
  return list.every((record) => {
    const keys = Object.keys(record);
    return keys.length === 1 && keys[0] === "ping";
  });
}

/**
 * How strongly a record looks like a device record (0 = not a device).
 * Used to reject decoy nodes and message arrays during auto-detection.
 */
export function deviceFieldScore(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 0;
  let score = 0;
  for (const key of Object.keys(record)) {
    if (DEVICE_SIGNAL_FIELDS.includes(key.toLowerCase())) score += 1;
  }
  // A record that only carries `ping` (wake-up decoy) is not a device.
  if (score === 0) return 0;
  if (Object.keys(record).length === 1 && "ping" in record) return 0;
  return score;
}

/** Sample records = plain-object entries of a node. */
export function objectEntries(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  return Object.entries(node).filter(
    ([, value]) => value && typeof value === "object" && !Array.isArray(value),
  );
}

/* ------------------------------------------------------------------ *
 * Device normalisation                                                *
 * ------------------------------------------------------------------ */

function pick(raw, aliases) {
  if (!raw || typeof raw !== "object") return undefined;
  const lower = new Map(
    Object.keys(raw).map((k) => [k.toLowerCase(), k]),
  );
  for (const alias of aliases) {
    const key = lower.get(alias.toLowerCase());
    if (key === undefined) continue;
    const value = raw[key];
    if (value === null || value === undefined || value === "") continue;
    return value;
  }
  return undefined;
}

/** "Model: Pixel 6\nAndroid: 13" and "Model: Pixel 6 | Android: 13". */
export function parseInfoBlob(value) {
  const out = {};
  if (typeof value !== "string" || !value.trim()) return out;
  for (const chunk of value.split(/[\n\r|;]+/)) {
    const idx = chunk.indexOf(":");
    if (idx <= 0) continue;
    const key = chunk.slice(0, idx).trim().toLowerCase();
    const val = chunk.slice(idx + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/**
 * Timestamps arrive as ms, seconds, ISO strings, "YYYY-MM-DD HH:mm:ss" or
 * "DD/MM/YYYY HH:mm:ss". Returns epoch ms or null.
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    // 10-digit values are seconds; 13-digit values are milliseconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }

  const s = String(value).trim();
  if (!s || isDeadValue(s)) return null;

  if (/^\d+$/.test(s)) return parseTimestamp(Number(s));

  const dmy = s.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (dmy) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = dmy;
    return Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss);
  }

  const ymd = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (ymd) {
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = ymd;
    return Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss);
  }

  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "online" | "offline" | "unknown" */
export function normalizeStatus(value) {
  if (value === true || value === 1) return "online";
  if (value === false || value === 0) return "offline";
  const s = String(value ?? "").trim().toLowerCase();
  if (["online", "active", "connected", "up", "1", "true", "yes"].includes(s)) {
    return "online";
  }
  if (["offline", "inactive", "disconnected", "down", "0", "false", "no"].includes(s)) {
    return "offline";
  }
  return "unknown";
}

function normalizeSim(rawSim, slot) {
  if (!rawSim || typeof rawSim !== "object") return null;
  const number = cleanString(
    pick(rawSim, ["phoneNumber", "number", "phone", "numberSim", "msisdn", "simNumber"]),
  );
  const carrier = cleanString(
    pick(rawSim, ["carrierName", "carrier", "operator", "name", "network", "nameSim"]),
  );
  const iccid = cleanString(pick(rawSim, ["iccid", "iccId", "serial", "simSerial"]));
  const type = cleanString(pick(rawSim, ["simType", "type", "slotType"]));
  if (!number && !carrier && !iccid) return null;
  return { slot: slot ?? null, number, carrier, iccid, type };
}

/**
 * Expands numberSim1..4 style keys, `sims` arrays/objects and Sim1/Sim2.
 * `sidecar` is the matching record from a SimINFO node, when the layout keeps
 * SIM data outside the device record.
 */
export function extractSims(raw, sidecar = null) {
  if (!raw || typeof raw !== "object") {
    if (!sidecar || typeof sidecar !== "object") return [];
  }
  const merged = sidecar && typeof sidecar === "object" ? { ...sidecar, ...(raw || {}) } : raw || {};
  raw = merged;
  const sims = [];
  const seen = new Set();
  const add = (sim) => {
    if (!sim) return;
    const key = `${sim.slot}|${sim.number}|${sim.carrier}|${sim.iccid}`;
    if (seen.has(key)) return;
    seen.add(key);
    sims.push(sim);
  };

  const container = raw.sims || raw.sim_info || raw.siminfo || raw.SIMs;
  if (Array.isArray(container)) {
    container.forEach((entry, i) => add(normalizeSim(entry, i + 1)));
  } else if (container && typeof container === "object") {
    Object.entries(container).forEach(([k, entry]) => {
      const slot = Number(String(k).replace(/\D/g, "")) || null;
      add(normalizeSim(entry, slot));
    });
  }

  for (let slot = 1; slot <= 4; slot += 1) {
    const number = cleanString(
      raw[`numberSim${slot}`] ?? raw[`phoneSim${slot}`] ?? raw[`number_sim${slot}`],
    );
    const carrier = cleanString(
      raw[`nameSim${slot}`] ?? raw[`carrierSim${slot}`] ?? raw[`operatorSim${slot}`],
    );
    const iccid = cleanString(raw[`iccIdSim${slot}`] ?? raw[`iccidSim${slot}`]);
    const type = cleanString(raw[`typeSim${slot}`] ?? raw[`simType${slot}`]);
    if (number || carrier || iccid) {
      add({ slot, number, carrier, iccid, type });
    }
  }

  // RTX layout (Sim1/Sim2) and SimINFO sidecars (sim1/sim2), where a slot can
  // be an object or a flat number.
  for (let slot = 1; slot <= 4; slot += 1) {
    const value = raw[`Sim${slot}`] ?? raw[`sim${slot}`] ?? raw[`SIM${slot}`];
    if (value && typeof value === "object") add(normalizeSim(value, slot));
    else if (typeof value === "string" || typeof value === "number") {
      const number = cleanString(value);
      if (number) add({ slot, number, carrier: "", iccid: "", type: "" });
    }
  }

  return sims;
}

/**
 * Normalise one device record.
 *
 * @param {object} raw   the record exactly as stored in the database
 * @param {string} id    the node key (device id)
 */
export function normalizeDevice(raw, id, simSidecar = null) {
  const record = raw && typeof raw === "object" ? raw : {};
  const info = parseInfoBlob(
    record.Device_info ?? record.device_info ?? record.deviceInfo ?? "",
  );

  const modelName =
    cleanString(pick(record, ["d_name", "DeviceName", "device_name", "model", "deviceModel", "name"])) ||
    cleanString(info.model) ||
    cleanString(info["device model"]) ||
    "";

  const sims = extractSims(record, simSidecar);
  const phoneNumber =
    cleanString(pick(record, ["phoneNumber", "mobNo", "mobile", "number", "phone"])) ||
    (sims.find((s) => s.number)?.number ?? "");

  const batteryRaw = pick(record, ["battery", "batt", "charge", "batteryLevel"]);
  const batteryNum = Number(String(batteryRaw ?? "").replace(/[^\d.]/g, ""));
  const battery = Number.isFinite(batteryNum) && String(batteryRaw ?? "").trim() !== ""
    ? Math.max(0, Math.min(100, Math.round(batteryNum)))
    : null;

  const lastSeen =
    parseTimestamp(pick(record, ["lastSeen", "last_seen", "TimeandDate", "lastSeenTime", "timestamp", "time", "ts", "updatedAt"])) ??
    parseTimestamp(record.ping?.ts);

  const joined = parseTimestamp(
    pick(record, ["installTime", "install_time", "joined", "createdAt", "registered"]),
  );

  const status = normalizeStatus(
    pick(record, ["status", "online", "isOnline", "connection"]),
  );

  const androidV =
    cleanString(pick(record, ["androidV", "android", "androidVersion", "os"])) ||
    cleanString(info.android) ||
    cleanString(info["os version"]) ||
    cleanString(info.os) ||
    "";

  const ip = cleanString(pick(record, ["ip", "ipAddress", "publicIp"]));
  const operator =
    cleanString(pick(record, ["operator", "carrier", "network"])) ||
    sims.find((s) => s.carrier)?.carrier ||
    "";

  const liveSims = sims.filter((s) => s.number || s.carrier || s.iccid);

  return {
    id: String(id ?? cleanString(record.id) ?? ""),
    modelName,
    phoneNumber,
    operator,
    battery,
    status,
    lastSeen,
    joined,
    androidV,
    ip,
    sims: liveSims,
    dualSim: liveSims.length >= 2,
    serial: cleanString(pick(record, ["uesr_serial", "user_serial", "serial", "device_serial"])),
    raw: record,
  };
}

/* ------------------------------------------------------------------ *
 * Message normalisation                                               *
 * ------------------------------------------------------------------ */

/**
 * Loose phone comparison: "919876543210" and "+91 98765 43210" are the same
 * number as "9876543210" for the purpose of direction detection.
 */
export function sameNumber(a, b) {
  const clean = (value) => String(value ?? "").replace(/[^\d]/g, "");
  const left = clean(a);
  const right = clean(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shortest = Math.min(left.length, right.length);
  if (shortest < 7) return false;
  return left.endsWith(right) || right.endsWith(left);
}

/**
 * Normalise one SMS record. `direction` is derived from a `type`/`dir` field
 * when present, otherwise from whether `to` matches the device number.
 */
export function normalizeMessage(raw, id, { deviceNumber = "" } = {}) {
  const record = raw && typeof raw === "object" ? raw : {};
  const body =
    cleanString(pick(record, ["body", "message", "text", "msg", "content", "sms"])) || "";
  const from = cleanString(pick(record, ["from", "sender", "address", "src", "origin"]));
  const to = cleanString(pick(record, ["to", "receiver", "destination", "dst"]));
  const ts = parseTimestamp(
    pick(record, ["timestamp", "time", "date", "ts", "sentAt", "receivedAt", "createdAt"]),
  );

  let direction = cleanString(pick(record, ["direction", "dir"])).toLowerCase();
  if (!["in", "out"].includes(direction)) {
    const type = cleanString(pick(record, ["type"])).toLowerCase();
    if (["sent", "out", "outbox", "outgoing", "send"].includes(type)) direction = "out";
    else if (["received", "in", "inbox", "incoming", "recv"].includes(type)) direction = "in";
    else if (deviceNumber && from && sameNumber(from, deviceNumber)) {
      direction = "out";
    } else direction = from ? "in" : "out";
  }

  return {
    id: String(id ?? cleanString(record.id) ?? ""),
    direction,
    from,
    to,
    body,
    ts,
    simSlot: cleanString(pick(record, ["simSlot", "sim_slot", "slot"])) || "",
    raw: record,
  };
}

/** Raw message fields that identify which device a message belongs to. */
const MESSAGE_DEVICE_FIELDS = [
  "deviceid", "device_id", "device", "did", "senderdevice", "clientid",
  "client_id", "client", "uid", "user", "targetdeviceid", "fromdevice",
];

/**
 * Best-effort device id for a stored message record, or "" when the record
 * does not carry one (e.g. a message array nested under the device node).
 */
export function deviceIdFromMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const lower = new Map(Object.keys(raw).map((k) => [k.toLowerCase(), k]));
  for (const field of MESSAGE_DEVICE_FIELDS) {
    const key = lower.get(field);
    if (key === undefined) continue;
    const value = raw[key];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue;
    return String(value).trim();
  }
  return "";
}

/** Sort newest first; entries without a timestamp keep their order at the end. */
export function sortByTimeDesc(list) {
  return [...(list || [])].sort(
    (a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity),
  );
}

/** Search across the fields a user would actually type. */
export function deviceMatches(device, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    device.id,
    device.modelName,
    device.phoneNumber,
    device.operator,
    device.ip,
    device.serial,
    device.androidV,
    ...(device.sims || []).flatMap((s) => [s.number, s.carrier, s.iccid]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

export function messageMatches(message, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const haystack = [message.from, message.to, message.body]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

/* ------------------------------------------------------------------ *
 * Presentation helpers                                                *
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

/** "just now" / "12m ago" / "3h ago" / "5d ago" / "2mo ago" / "never". */
export function relativeTime(ts, now = Date.now()) {
  if (!ts || !Number.isFinite(ts)) return "never";
  const delta = now - ts;
  if (delta < 0) return "just now";
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < MONTH) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < 12 * MONTH) return `${Math.floor(delta / MONTH)}mo ago`;
  return `${Math.floor(delta / (12 * MONTH))}y ago`;
}

export function formatTimestamp(ts) {
  if (!ts || !Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}

/** Human byte size for payload notices. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
