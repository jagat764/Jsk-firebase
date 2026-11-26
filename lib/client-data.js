function safeText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

export function mergeClientProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const nestedKeys = [
    "deviceInfo", "DeviceInfo", "device_info", "Device_info",
    "profile", "Profile", "details", "Details", "data", "Data",
    "info", "Info", "device", "Device",
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
  const mobile = safeText(client.mobNo);
  if (mobile && mobile.toLowerCase() !== "unknown") numbers.push(mobile);
  if (Array.isArray(client.sims)) {
    for (const sim of client.sims) {
      if (sim == null) continue;
      const number = safeText(
        typeof sim === "object" ? sim.phoneNumber ?? sim.number ?? sim.phone ?? sim.msisdn : sim,
      );
      if (number && number.toLowerCase() !== "unknown" && !numbers.includes(number)) {
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
    const number = safeText(
      typeof sim === "object" ? sim.phoneNumber ?? sim.number ?? sim.phone ?? sim.msisdn : sim,
    );
    if (number && number.toLowerCase() !== "unknown") return number;
  }
  return "";
}

export function providerForClient(client) {
  if (!client || typeof client !== "object") return "—";
  const direct = safeText(client.service_provider);
  if (direct && direct.toLowerCase() !== "unknown") return direct;
  const providers = Array.isArray(client.sims)
    ? client.sims
        .map((sim) => safeText(sim && typeof sim === "object" ? sim.carrierName : ""))
        .filter((value) => value && value.toLowerCase() !== "unknown")
    : [];
  return providers.length ? providers.join(" | ") : "—";
}

export function simCountForClient(client) {
  if (!client || !Array.isArray(client.sims)) return 0;
  return client.sims.filter((sim) => {
    if (sim == null) return false;
    const number = safeText(
      typeof sim === "object" ? sim.phoneNumber ?? sim.number ?? sim.phone ?? sim.msisdn : sim,
    );
    return number && number.toLowerCase() !== "unknown";
  }).length;
}
