/**
 * Mobile-number lookup — the one feature added to the original panel.
 *
 * The header toggle (person_search icon) turns lookup mode on: every device
 * card then shows its SIM number with a "Lookup" chip. Clicking the chip opens
 * the lookup sheet for that device's number.
 *
 * Nothing else in the panel is touched: this module only decorates the cards
 * that app_v9.js renders and talks to the check-mobile service.
 */

import {
  checkMobile,
  flattenResult,
  normalizeMobile,
  DEFAULT_LOOKUP_ENDPOINT,
} from "./lib/lookup.js";

const SETTINGS_KEY = "fbmp.lookup.v1";
const MODE_KEY = "fbmp.lookupMode";
const DIRECT_FLAG = new URLSearchParams(location.search).get("direct") === "1";

const $ = (id) => document.getElementById(id);

const settings = loadSettings();
let lookupMode = false;
let lastResult = null;

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    saved = {};
  }
  return {
    endpoint: saved.endpoint || DEFAULT_LOOKUP_ENDPOINT,
    token: saved.token || "",
    initData: saved.initData || "",
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

function toast(message, type = "info") {
  const container = $("toastNotificationContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `p-2.5 rounded-xl border shadow-2xl font-mono text-[10px] font-bold flex items-center space-x-2 transition-all duration-300 translate-y-2 bg-slate-950 pointer-events-auto ${
    type === "success"
      ? "border-emerald-500/20 text-emerald-400"
      : type === "error"
        ? "border-rose-500/20 text-rose-400"
        : "border-slate-800 text-cyan-400"
  }`;
  el.innerHTML = `<span class="material-icons text-xs">notifications</span><span></span>`;
  el.lastElementChild.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.remove("translate-y-2"));
  setTimeout(() => {
    el.classList.add("opacity-0", "translate-y-1");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

/* ---------------------------------------------------------------- device cards */

function phoneFromCard(card) {
  const text = card.textContent || "";
  const chip = text.match(/SIM\d+\s*:\s*(\+?[\d][\d\s-]{7,})/i);
  const any = text.match(/(?:\+?91[\s-]?)?([6-9]\d{9})/);
  const raw = (chip && chip[1]) || (any && any[1]) || "";
  const digits = normalizeMobile(raw);
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

function decorateCards() {
  const container = $("clientsContainer");
  if (!container) return;
  container.querySelectorAll(".client-interactive-card").forEach((card) => {
    if (card.querySelector("[data-lookup-btn]")) {
      const strip = card.querySelector(".lookup-strip");
      const label = strip && strip.querySelector(".lookup-strip-phone");
      const number = phoneFromCard(card);
      if (label && number && label.textContent !== number) label.textContent = number;
      return;
    }
    const number = phoneFromCard(card);
    const strip = document.createElement("div");
    strip.className = "lookup-strip";
    strip.innerHTML = `
      <span class="lookup-strip-phone"></span>
      <button type="button" data-lookup-btn class="lookup-chip" title="Look up this device's number">
        <span class="material-icons">person_search</span><span>Lookup</span>
      </button>`;
    strip.querySelector(".lookup-strip-phone").textContent = number || "no number";
    strip.dataset.deviceId = card.getAttribute("data-id") || "";
    strip.dataset.number = number;
    card.appendChild(strip);
  });
}

/* ---------------------------------------------------------------- lookup sheet */

function openSheet(deviceId, number) {
  const modal = $("lookupModal");
  if (!modal) return;
  $("lookupSubtitle").textContent = deviceId ? `device ${deviceId}` : "manual lookup";
  $("lookupMobileInput").value = number || "";
  $("lookupResult").innerHTML = "";
  $("lookupRunFeedback").classList.add("hidden");
  modal.classList.remove("hidden");
  if (number) runLookup();
  else $("lookupMobileInput").focus();
}

function closeSheet() {
  const modal = $("lookupModal");
  if (modal) modal.classList.add("hidden");
}

function proxyUrl() {
  if (DIRECT_FLAG) return undefined;
  if (!/^https?:/.test(location.protocol)) return undefined;
  try {
    return new URL("api/lookup", location.href).toString();
  } catch {
    return undefined;
  }
}

async function runLookup() {
  const mobile = $("lookupMobileInput").value.trim();
  const feedback = $("lookupRunFeedback");
  const resultBox = $("lookupResult");
  const runBtn = $("lookupRunBtn");

  feedback.classList.add("hidden");
  resultBox.innerHTML = "";

  if (!settings.token) {
    $("lookupSettingsPanel").classList.remove("hidden");
    feedback.textContent = "Add the service token first (settings icon).";
    feedback.classList.remove("hidden");
    $("lookupTokenInput").focus();
    return;
  }

  runBtn.disabled = true;
  resultBox.innerHTML = `<div class="lookup-empty">Looking up ${mobile || "…"}…</div>`;

  try {
    const result = await checkMobile(mobile, {
      endpoint: settings.endpoint.trim(),
      token: settings.token,
      initData: settings.initData,
      proxyUrl: proxyUrl(),
    });
    lastResult = result;

    const rows = flattenResult(result.data).slice(0, 60);
    const header = document.createElement("div");
    header.className = "flex items-center justify-between text-[9px] font-mono text-slate-500 px-1";
    header.innerHTML = `<span class="text-emerald-400 font-bold">HTTP ${result.status}</span><span></span>`;
    header.lastElementChild.textContent = `${result.ms} ms${result.viaProxy ? " · via proxy" : ""}`;

    const list = document.createElement("div");
    list.className = "space-y-1";
    for (const [key, value] of rows) {
      const row = document.createElement("div");
      row.className = "lookup-row";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = value === null || value === undefined ? "—" : String(value);
      row.append(k, v);
      list.appendChild(row);
    }
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "lookup-empty";
      empty.textContent = "The service returned no fields for this number.";
      list.appendChild(empty);
    }

    resultBox.append(header, list);
  } catch (error) {
    resultBox.innerHTML = "";
    const box = document.createElement("div");
    box.className =
      "bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-[10px] font-mono text-rose-300 leading-relaxed";
    box.textContent = error?.message || "Lookup failed.";
    resultBox.appendChild(box);
  } finally {
    runBtn.disabled = false;
  }
}

/* ---------------------------------------------------------------- wiring */

function setLookupMode(on, { announce = true } = {}) {
  lookupMode = Boolean(on);
  document.body.classList.toggle("lookup-mode", lookupMode);
  const btn = $("lookupToggleBtn");
  if (btn) {
    btn.classList.toggle("text-cyan-400", lookupMode);
    btn.classList.toggle("border-cyan-500/40", lookupMode);
    btn.classList.toggle("text-slate-300", !lookupMode);
  }
  try {
    localStorage.setItem(MODE_KEY, lookupMode ? "1" : "0");
  } catch {}
  if (lookupMode) decorateCards();
  if (announce) {
    toast(lookupMode ? "Lookup mode on — use the chip on any device card" : "Lookup mode off", "info");
  }
}

function boot() {
  // card decoration (app_v9.js re-renders the grid constantly)
  const container = $("clientsContainer");
  if (container) {
    decorateCards();
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (lookupMode) decorateCards();
      });
    }).observe(container, { childList: true, subtree: true });
  }

  // header toggle
  const toggleBtn = $("lookupToggleBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => setLookupMode(!lookupMode));
    let saved = "0";
    try {
      saved = localStorage.getItem(MODE_KEY) || "0";
    } catch {}
    setLookupMode(saved === "1", { announce: false });
  }

  // delegated chip clicks (capture phase so the card's own click never fires)
  document.addEventListener(
    "click",
    (event) => {
      const chip = event.target.closest && event.target.closest("[data-lookup-btn]");
      if (!chip) return;
      event.preventDefault();
      event.stopPropagation();
      const strip = chip.closest(".lookup-strip");
      openSheet(strip?.dataset.deviceId || "", strip?.dataset.number || "");
    },
    true,
  );

  // sheet controls
  $("closeLookupBtn")?.addEventListener("click", closeSheet);
  $("lookupBackdrop")?.addEventListener("click", closeSheet);
  $("lookupRunBtn")?.addEventListener("click", runLookup);
  $("lookupMobileInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runLookup();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet();
  });

  // settings
  $("lookupSettingsBtn")?.addEventListener("click", () => {
    const panel = $("lookupSettingsPanel");
    $("lookupEndpointInput").value = settings.endpoint;
    $("lookupTokenInput").value = settings.token;
    $("lookupInitDataInput").value = settings.initData;
    panel.classList.toggle("hidden");
  });
  const persist = () => {
    settings.endpoint = $("lookupEndpointInput").value.trim() || DEFAULT_LOOKUP_ENDPOINT;
    settings.token = $("lookupTokenInput").value.trim();
    settings.initData = $("lookupInitDataInput").value;
    saveSettings();
  };
  for (const id of ["lookupEndpointInput", "lookupTokenInput", "lookupInitDataInput"]) {
    $(id)?.addEventListener("change", persist);
    $(id)?.addEventListener("blur", persist);
  }

  // expose for debugging from the console
  window.fbLookup = { run: runLookup, mode: setLookupMode, get last() { return lastResult; } };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
