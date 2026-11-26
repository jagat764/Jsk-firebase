function safeText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

function usablePhone(value) {
  const text = safeText(value);
  return text && !/^(unknown|none|null|undefined|no sim found|no data|not available|-)$/i.test(text)
    ? text
    : "";
}

export function mergeClientProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const nestedKeys = [
    "deviceInfo", "DeviceInfo", "device_info", "Device_info",
    "profile", "Profile", "details", "Details", "data", "Data",
    "info", "Info", "device", "Device", "SimINFO", "SimInfo", "simInfo",
    "siminfo", "simDetails", "SimDetails",
  ];
  const merged = {};
  const assignUsefulValues = (source) => {
    for (const [key, value] of Object.entries(source)) {
      const hasUsefulValue =
        value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
      if (hasUsefulValue || !(key in merged)) merged[key] = value;
    }
  };
  for (const key of nestedKeys) {
    const nested = profile[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      assignUsefulValues(nested);
    }
  }
  assignUsefulValues(profile);
  return merged;
}

const SIM_NUMBER_KEYS = [
  "phoneNumber", "phone_number", "number", "phone", "msisdn", "mobile",
  "mobileNumber", "mobNo", "mob_no", "Number", "Mobile",
];
const SIM_CARRIER_KEYS = [
  "carrierName", "carrier_name", "carrier", "operator", "network",
  "provider", "serviceProvider", "service_provider", "name",
];
const SIM_TYPE_KEYS = ["simType", "sim_type", "type", "technology"];
const SIM_ICCID_KEYS = ["iccid", "iccId", "icc_id", "serial", "serialNumber"];

function firstUseful(record, keys) {
  if (!record || typeof record !== "object") return undefined;
  const aliases = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const actualKey = key in record ? key : aliases.get(key.toLowerCase());
    const value = actualKey ? record[actualKey] : undefined;
    const text = safeText(value);
    if (
      text &&
      !/^(unknown|none|null|undefined|no sim found|no data|not available|-)$/i.test(text)
    ) return value;
  }
}

function mergeUseful(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (firstUseful({ value }, ["value"]) !== undefined) target[key] = value;
  }
  return target;
}

function parseSimString(value) {
  const text = safeText(value);
  if (!text || /^(no sim found|no data|not available|unknown|none|null|-)$/i.test(text)) {
    return null;
  }
  const match = text.match(/\+?\d[\d\s().-]{7,}\d/);
  const digits = match ? match[0].replace(/\D/g, "") : "";
  const phoneNumber = digits.length >= 10 ? digits.slice(-10) : "";
  const remainder = match
    ? text.replace(match[0], "").replace(/^\s*[|:—–-]\s*|\s*[|:—–-]\s*$/g, "").trim()
    : "";
  const carrierName = (remainder || (!match && !/^(yes|no|true|false|1|0)$/i.test(text) ? text : "")) &&
    !/^(unknown|none|no sim found|no data|not available|-)$/i.test(remainder || text)
    ? remainder || text
    : "";
  return phoneNumber || carrierName ? { phoneNumber, carrierName } : null;
}

function normalizeSimRecord(value, slot) {
  if (value == null) return null;
  const parsed = typeof value === "string" || typeof value === "number"
    ? parseSimString(value)
    : null;
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawNumber = safeText(firstUseful(record, SIM_NUMBER_KEYS)) ||
    (typeof value === "number" ? safeText(value) : parsed?.phoneNumber || "");
  const numberDigits = rawNumber.replace(/\D/g, "");
  const phoneNumber = numberDigits.length >= 10 ? numberDigits.slice(-10) : rawNumber;
  const carrierName = safeText(firstUseful(record, SIM_CARRIER_KEYS)) || parsed?.carrierName || "";
  const simType = safeText(firstUseful(record, SIM_TYPE_KEYS));
  const iccid = safeText(firstUseful(record, SIM_ICCID_KEYS));
  if (![phoneNumber, carrierName, simType, iccid].some(Boolean)) return null;
  return {
    ...(phoneNumber ? { phoneNumber } : {}),
    ...(carrierName ? { carrierName } : {}),
    ...(simType ? { simType } : {}),
    ...(iccid ? { iccid } : {}),
    slot: Number(firstUseful(record, ["slot", "simSlot", "sim_slot"])) || slot,
  };
}

export function normalizeClientSims(profile, sidecar) {
  const sources = [mergeClientProfile(sidecar), mergeClientProfile(profile)];
  const slots = new Set([1, 2, 3, 4]);
  for (const source of sources) {
    for (const key of Object.keys(source)) {
      const match = key.match(/^(?:number|name|type|icc.?id|phone|carrier|sim)[_-]?(\d+)$/i);
      if (match) slots.add(Number(match[1]));
    }
    const lists = [
      source.sims, source.Sims, source.SIMs,
      source.SimINFO, source.SimInfo, source.simInfo, source.siminfo, source.simDetails, source.SimDetails,
    ];
    for (const list of lists) {
      if (Array.isArray(list)) list.forEach((_, index) => slots.add(index + 1));
      else if (list && typeof list === "object") {
        for (const key of Object.keys(list)) {
          const match = key.match(/(?:sim|slot)?[_-]?(\d+)$/i);
          if (match) slots.add(Number(match[1]));
        }
      }
    }
  }

  const normalized = [];
  for (const slot of [...slots].filter((n) => Number.isInteger(n) && n > 0 && n <= 10).sort((a, b) => a - b)) {
    let merged = {};
    for (const source of sources) {
      const list =
        source.sims ?? source.Sims ?? source.SIMs ?? source.SimINFO ?? source.SimInfo ??
        source.simInfo ?? source.siminfo ?? source.simDetails ?? source.SimDetails;
      const listed = Array.isArray(list)
        ? list[slot - 1]
        : list && typeof list === "object"
          ? list[`sim${slot}`] ?? list[`Sim${slot}`] ?? list[`slot${slot}`] ??
            list[`Slot${slot}`] ?? list[String(slot)]
          : undefined;
      const direct = source[`sim${slot}`] ?? source[`Sim${slot}`] ?? source[`SIM${slot}`];
      const value = direct ?? listed;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        mergeUseful(merged, value);
      } else if (value != null) {
        const parsed = parseSimString(value);
        if (parsed) merged = { ...merged, ...parsed };
      }

      const inline = {
        phoneNumber: firstUseful(source, [
          `numberSim${slot}`, `number_sim${slot}`, `phoneSim${slot}`, `mobileSim${slot}`,
        ]),
        carrierName: firstUseful(source, [
          `nameSim${slot}`, `name_sim${slot}`, `carrierSim${slot}`, `operatorSim${slot}`,
        ]),
        simType: firstUseful(source, [`typeSim${slot}`, `type_sim${slot}`]),
        iccid: firstUseful(source, [`iccIdSim${slot}`, `iccidSim${slot}`, `icc_id_sim${slot}`]),
      };
      Object.entries(inline).forEach(([key, field]) => {
        const text = safeText(field);
        if (text) merged[key] = text;
      });
    }
    const record = normalizeSimRecord(merged, slot);
    if (record) normalized.push(record);
  }

  const seenNumbers = new Set();
  return normalized.filter((sim) => {
    if (!sim.phoneNumber) return true;
    const key = sim.phoneNumber.replace(/\D/g, "");
    if (seenNumbers.has(key)) return false;
    seenNumbers.add(key);
    return true;
  });
}

export function hasClientRecords(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  return Object.entries(node).some(
    ([key, value]) =>
      key && !(key.startsWith("{") && key.endsWith("}")) &&
      value !== null && typeof value === "object",
  );
}

export function phoneNumbersForClient(client) {
  if (!client || typeof client !== "object") return [];
  const numbers = [];
  const mobile = usablePhone(client.mobNo);
  if (mobile) numbers.push(mobile);
  if (Array.isArray(client.sims)) {
    for (const sim of client.sims) {
      if (sim == null) continue;
      const number = usablePhone(
        typeof sim === "object" ? firstUseful(sim, SIM_NUMBER_KEYS) : sim,
      );
      if (number && !numbers.includes(number)) {
        numbers.push(number);
      }
    }
  }
  return numbers;
}

export function firstSimMobile(sims) {
  if (!Array.isArray(sims)) return "";
  for (const sim of sims) {
    if (sim == null) continue;
    const number = usablePhone(
      typeof sim === "object" ? firstUseful(sim, SIM_NUMBER_KEYS) : sim,
    );
    if (number) return number;
  }
  return "";
}

export function carrierNamesForClient(client) {
  if (!client || !Array.isArray(client.sims)) return [];
  const carriers = [];
  for (const sim of client.sims) {
    const carrier = safeText(
      typeof sim === "object" ? firstUseful(sim, SIM_CARRIER_KEYS) : "",
    );
    if (carrier && !carriers.includes(carrier)) carriers.push(carrier);
  }
  return carriers;
}

export function providerForClient(client) {
  if (!client || typeof client !== "object") return "—";
  const direct = safeText(firstUseful(client, [
    "service_provider", "serviceProvider", "carrierName", "carrier_name", "carrier",
    "operator", "network", "provider",
  ]));
  if (direct) return direct;
  const carriers = carrierNamesForClient(client);
  return carriers.length ? carriers.join(" | ") : "—";
}

export function simCountForClient(client) {
  if (!client || !Array.isArray(client.sims)) return 0;
  return client.sims.filter((sim) => {
    if (sim == null) return false;
    if (typeof sim !== "object") {
      const number = safeText(sim);
      return number && !/^(unknown|none|no sim found|-)$/i.test(number);
    }
    return [
      firstUseful(sim, SIM_NUMBER_KEYS),
      firstUseful(sim, SIM_CARRIER_KEYS),
      firstUseful(sim, SIM_TYPE_KEYS),
      firstUseful(sim, SIM_ICCID_KEYS),
    ].some((value) => value !== undefined);
  }).length;
}
