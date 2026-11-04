// ============================================================================
// cycle-tab.js — the 📍 Scan tab (it replaced the old Live, Locations and Cycle
// tabs, which all did "scan a product, then maybe a place").
//
// THE WORKFLOW (Nov 2026):
//   1. Before the live, pieces are taken out of their sample containers — no scan.
//   2. During the live, VHM Live Log records which codes were shown
//      (⏺ Start live … ⏹ End live → kv/live_last, read by live-feed.js).
//   3. After the live, 👕 Put back: scan product → scan its container. The
//      "Put back" list ticks each shown code off; what's left is still out.
//   4. Container full → 📦 Stock (replacement). 🏷 Set shelf = stock shelf.
// A shown code counts as "in the Live Room" until it is scanned back (any move
// after the live started). Putting it back logs Live → Sample and adds 1 to
// its "times live". (Older notes below still describe the 🎥 Live Room / ➡ Next
// step stations — those were removed: Live Log replaces them.)
//
//   👕 Sample / 🎥 Live Room / 📦 Stock / ➡ Next step — log the cycle (below)
//   🏷 Shelf — set a product's 📦 stock shelf location: scan product → scan shelf
//      (B23). A different saved shelf is never replaced without "Replace".
//   📌 Same location for the next items — scan a container / shelf once, then
//      only products (filling one shelf or container).
//   🎥 Live Room also suggests what to bring out next (same category + tag, in
//   Sample, used least), and the board flags pieces in the Live Room 7+ days (⏰).
//
// The cycle — log every step of a sample piece by scanning:
//
//     👕 Sample  ⇄  🎥 Live Room   (the normal cycle, repeats)
//     📦 Stock — only when the sample container is full: the extra piece goes to
//                Stock as a replacement, and comes back to Sample / Live later.
//
// How staff use it:
//   1. Pick the station once (tap a button, or scan its station barcode:
//      STOCK / SAMPLE / LIVE). The station is remembered on this device, so the
//      scanner in the live room just stays on 🎥 Live Room.
//      Or choose "➡ Next step": each scan moves the code one step along the cycle.
//   2. Scan products — master code (E366), POS / alternate code, or PokPok label
//      (P0003955, through the VHM Scan map). Every scan = one logged move.
//      Going to 👕 Sample = putting it in a sample container, so it takes 2 scans:
//      the product, then the container's location barcode (e.g. S3). That one move
//      saves both "now in Sample" and the 👕 sample location on the product
//      (📌 Same container: scan the container once, then just the products).
//      A Sample-mode scan in the 📍 Locations tab counts as the same move.
//
// Checks: scanning a code into the stage it is already in logs nothing (warning
// beep). A move to Stock is logged with reason "sample_full". The same code scanned twice within
// a few seconds (a double beep of the scanner) is ignored.
//
// Data: cycle_log (one doc per move) + cycle_stage / cycle_at / cycle_round on the
// product. Cost: 2 writes per scan (one batch), nothing read. The board below
// uses the product list app.js already keeps live. History / day log read only
// when opened. cycle_round = how many times the code has gone into the Live Room.
// ============================================================================

import { logCycleMove, undoCycleMove, listCycleLogForProduct, listCycleLogBetween, patchProduct } from "./db.js";
import { findVariantByCode } from "./search.js";
import { toast, escapeHtml } from "./ui-components.js";
import { LOCATION_FIELDS, SAMPLE_LOCATIONS, STORAGE_LOCATIONS } from "./constants.js";
import { loadStockMap, currentStockMap, codesForNumber, useMapFile, onStockMap, stockMapError } from "./stock-map.js";
import { checkLive, liveLast, liveError, onLive, shownEntry } from "./live-feed.js";

export const STAGES = {
  STOCK: { icon: "📦", en: "Stock", km: "ស្តុក", cls: "cy-stock" },
  SAMPLE: { icon: "👕", en: "Sample", km: "គំរូ", cls: "cy-sample" },
  LIVE: { icon: "🎥", en: "Live Room", km: "បន្ទប់ Live", cls: "cy-live" },
};
const ORDER = ["SAMPLE", "LIVE", "STOCK"];
// "➡ Next step": Sample ⇄ Live; a replacement in Stock comes back to Sample
const NEXT = { SAMPLE: "LIVE", LIVE: "SAMPLE", STOCK: "SAMPLE" };
// station barcodes (what the printed station labels contain) — a few spellings accepted
const STATION_CODES = {
  STOCK: "STOCK", "STAGE-STOCK": "STOCK", "@STOCK": "STOCK",
  SAMPLE: "SAMPLE", "STAGE-SAMPLE": "SAMPLE", "@SAMPLE": "SAMPLE",
  LIVE: "LIVE", LIVEROOM: "LIVE", "LIVE-ROOM": "LIVE", "STAGE-LIVE": "LIVE", "@LIVE": "LIVE",
  NEXT: "NEXT", "STAGE-NEXT": "NEXT", "@NEXT": "NEXT",
  SHELF: "SHELF", "STAGE-SHELF": "SHELF", "@SHELF": "SHELF",
};
const ROTATION_DAYS = 7;   // a piece in the Live Room this long gets ⏰ on the board
const DOUBLE_SCAN_MS = 4000;

const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();
const LS_KEY = "vhminv_cycle_";
const lsGet = (k, d) => { try { const v = localStorage.getItem(LS_KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS_KEY + k, JSON.stringify(v)); } catch (e) {} };

let actx = null;
function tone(f, d, when = 0) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + when; o.frequency.value = f; g.gain.setValueAtTime(.3, t); g.gain.exponentialRampToValueAtTime(.001, t + d); o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + d); } catch (e) {} }
const beepOk = () => { tone(1320, .08); tone(1760, .1, .1); }, beepWarn = () => { tone(660, .12); tone(660, .12, .18); }, beepBad = () => { tone(220, .25); tone(180, .3, .28); }, beepStep = () => tone(990, .07);
const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };

export function stageChip(stage, sinceIso) {
  const s = STAGES[stage]; if (!s) return "";
  return `<span class="cy-chip ${s.cls}" title="Cycle: now in ${s.en}">${s.icon} ${s.en}${sinceIso ? ` · ${ago(sinceIso)}` : ""}</span>`;
}
export function ago(isoOrMs) {
  const ms = Date.now() - (typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime());
  if (!isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
// One move of product p to stage `to` — shared by this tab and the 📍 Locations tab.
// Returns what logCycleMove needs (mv, patch) and what undoCycleMove needs (prev).
export function buildCycleMove(p, to, { scanned = "", station = "", variant = null, location = "", liveEntry = null } = {}) {
  // a code shown in the last live and not back yet comes FROM the Live Room
  const from = liveEntry ? "LIVE" : (p.cycle_stage || null);
  const prevRound = Number(p.cycle_round) || 0;
  const sampleField = LOCATION_FIELDS.sample;
  const patch = {}, prev = { cycle_stage: p.cycle_stage ?? null, cycle_at: p.cycle_at ?? null, cycle_round: p.cycle_round ?? 0 };
  if (to === "SAMPLE" && location) { patch[sampleField] = location; prev[sampleField] = p[sampleField] ?? ""; }
  const mv = {
    from, to, scanned, station,
    round: to === "LIVE" || liveEntry ? prevRound + 1 : prevRound,   // = times this code has gone to the Live Room
    live_id: liveEntry ? (liveEntry.liveId || "") : "",
    skipped: false,
    reason: to === "STOCK" ? "sample_full" : "",
    location: to === "SAMPLE" ? (location || p[sampleField] || "") : to === "STOCK" ? (p[LOCATION_FIELDS.stock] || "") : "",
    location_was: to === "SAMPLE" && location ? (p[sampleField] || "") : "",
    in_from_ms: liveEntry ? Date.now() - new Date(liveEntry.last).getTime()
      : p.cycle_at ? Date.now() - new Date(p.cycle_at).getTime() : null,   // how long it sat in the previous stage
    variant: variant ? { size: variant.size || "", color: variant.color_name || "", pos: variant.pos_code || "" } : null,
  };
  return { mv, patch, prev };
}
const BIN_RE = /^[A-Z]{1,3}-?\d{1,3}$/;
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function initCycleTab(container, { getProducts, onProducts }) {
  const state = {
    products: [],
    byMaster: new Map(),
    station: ["SAMPLE", "STOCK", "SHELF"].includes(lsGet("station", "SAMPLE")) ? lsGet("station", "SAMPLE") : "SAMPLE",   // SAMPLE (put back) | STOCK | SHELF
    pick: null,                            // { code, products, variant } when one label = several products
    last: null,                            // last result shown under the scan box
    log: [],                               // this session: { logId, product, from, to, prev, t, skipped, undone }
    lastScan: { code: "", t: 0 },
    boardFilter: "",
    pending: null,                         // { kind: "sample" | "shelf", product, scanned, variant } waiting for a location
    confirm: null,                         // { product, loc, from } — shelf already set: "Replace" or "Keep"?
    lock: lsGet("lock", false),            // 📌 same location (container / shelf) for the next items
    lockedLoc: "",
  };

  container.innerHTML = `
    <div class="cy-flow muted">
      <span class="cy-chip cy-sample">👕 Sample container</span><span class="cy-arrow">→</span><span class="cy-chip cy-live">🎥 Live</span>
      <span class="cy-side">(no scan — Live Log records it)</span><span class="cy-arrow">→</span><b>scan it back</b><span class="cy-arrow">→</span><span class="cy-chip cy-sample">👕 Sample container</span>
    </div>
    <div id="cy-putback" class="cy-putback"></div>
    <div class="live-tabs cy-stations">
      <button class="live-tab-btn cy-main-btn" data-st="SAMPLE">👕 Put back · ដាក់វិញ</button>
      <span class="cy-more-label muted">More:</span>
      <button class="live-tab-btn cy-more-btn" data-st="STOCK">📦 To Stock (box full) · ទៅស្តុក</button>
      <button class="live-tab-btn cy-more-btn" data-st="SHELF">🏷 Set shelf · កំណត់ធ្នើ</button>
    </div>
    <div class="scan-box loc-box">
      <div id="cy-step" class="loc-step"></div>
      <input id="cy-input" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" placeholder="Scan product · ស្កេនទំនិញ" />
      <label class="loc-lock" id="cy-lock-wrap"><input type="checkbox" id="cy-lock" /> 📌 Same location for the next items · ទីតាំងដដែលសម្រាប់ទំនិញបន្ទាប់</label>
      <div class="loc-actions">
        <button type="button" class="btn btn-secondary" id="cy-cancel">Clear · សម្អាត</button>
        <button type="button" class="btn btn-secondary" id="cy-labels">🖨 Station labels · ស្លាកស្ថានីយ</button>
        <button type="button" class="btn btn-secondary" id="cy-loclabels">🖨 Location labels · ស្លាកទីតាំង</button>
        <button type="button" class="btn btn-secondary" id="cy-day">📜 Day log · កំណត់ត្រាប្រចាំថ្ងៃ</button>
      </div>
    </div>
    <div id="cy-result"></div>
    <div class="loc-map muted" id="cy-map"></div>
    <div id="cy-log"></div>
    <h3 style="margin-top:24px;">Where every piece is now · ទីតាំងបច្ចុប្បន្ន</h3>
    <input id="cy-filter" class="cy-filter" type="search" placeholder="Filter by code · ស្វែងរកកូដ" />
    <div id="cy-board" class="cy-board"></div>
  `;
  const $ = s => container.querySelector(s);
  const input = $("#cy-input");

  container.querySelectorAll(".cy-stations .live-tab-btn").forEach(b => b.onclick = () => setStation(b.dataset.st));
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const v = input.value; input.value = ""; handleScan(v); } });
  $("#cy-labels").onclick = printStationLabels;
  $("#cy-loclabels").onclick = printLocationLabels;
  $("#cy-lock").checked = state.lock;
  $("#cy-lock").onchange = e => { state.lock = e.target.checked; lsSet("lock", state.lock); if (!state.lock) state.lockedLoc = ""; renderStep(); input.focus(); };
  $("#cy-cancel").onclick = () => { state.pending = null; state.pick = null; state.confirm = null; state.lockedLoc = ""; state.last = null; renderStep(); renderResult(); input.focus(); };
  $("#cy-day").onclick = () => openDayLog();
  $("#cy-filter").oninput = e => { state.boardFilter = norm(e.target.value); renderBoard(); };

  function useProducts(products) {
    state.products = (products || []).filter(p => !p.deleted);
    state.byMaster = new Map(state.products.map(p => [norm(p.master_code), p]));
    if (state.pending) state.pending.product = state.products.find(p => p.id === state.pending.product.id) || state.pending.product;
    renderBoard(); renderResult(); renderPutback();
  }
  useProducts(getProducts());
  const unsub = onProducts(useProducts);
  const stopMap = onStockMap(() => renderMapInfo());
  loadStockMap().then(renderMapInfo);
  // keep the "time in stage" numbers on the board fresh
  const ticker = setInterval(() => { if (!container.closest("[hidden]")) renderBoard(); }, 60000);
  // the last live from VHM Live Log: on open, then every 5 minutes while this tab is on screen
  const stopLive = onLive(() => { renderPutback(); renderBoard(); });
  checkLive();
  const liveTicker = setInterval(() => { if (!container.closest("[hidden]") && !document.hidden) checkLive(); }, 5 * 60 * 1000);

  function setStation(st) {
    state.station = st; lsSet("station", st); state.pick = null; state.pending = null; state.confirm = null; state.lockedLoc = "";
    state.lastScan = { code: "", t: 0 };          // a new station = the next scan of the same code is a real move
    renderStations(); renderStep(); input.focus();
  }

  // ---------------- scanning ----------------
  function findProducts(raw) {
    const code = norm(raw);
    if (!code) return { list: [] };
    const m = state.byMaster.get(code);
    if (m) return { list: [m] };
    const v = findVariantByCode(state.products, code);
    if (v) return { list: [v.product], variant: v.variant };
    return { list: codesForNumber(code).map(s => state.byMaster.get(s)).filter(Boolean) };
  }

  async function handleScan(raw, retried) {
    const code = norm(raw);
    if (!code) return;
    // a station barcode switches the station
    if (STATION_CODES[code]) {
      const st = STATION_CODES[code];
      if (st === "LIVE" || st === "NEXT") { beepWarn(); toast("The Live Room is recorded by VHM Live Log now — no scan needed", "error"); return; }
      setStation(st); beepStep(); buzz(25); toast(`Station: ${st === "SHELF" ? "🏷 Set shelf" : st === "SAMPLE" ? "👕 Put back" : "📦 To Stock"}`); return;
    }
    // the scanner's double beep: same code again within a few seconds = ignore
    if (code === state.lastScan.code && Date.now() - state.lastScan.t < DOUBLE_SCAN_MS) return;
    state.pick = null;
    if (state.confirm) keepShelf(true);           // a new scan while "Replace?" is open = keep the saved shelf
    let found = findProducts(code);
    const isLoc = BIN_RE.test(code) || SAMPLE_LOCATIONS.map(norm).includes(code) || STORAGE_LOCATIONS.map(norm).includes(code);
    // waiting for the sample container: a location wins, unless this is clearly another product (then switch to it)
    // (a real product code always means a product: product codes like R292 look like locations too)
    if (state.pending && !found.list.length && !/^P\d{5,}$/.test(code)) {
      const pd = state.pending; state.pending = null;
      state.lastScan = { code, t: Date.now() };   // a location came in between → the same product next is a real scan
      if (pd.kind === "shelf") saveShelf(pd.product, code); else commit(pd.product, "SAMPLE", pd.scanned, pd.variant, code);
      return;
    }
    // 📌 a container / shelf scanned first = the one to fill
    if (!state.pending && !found.list.length && isLoc && state.lock && lockable()) { state.lockedLoc = code; beepStep(); renderStep(); renderResult(); input.focus(); return; }
    if (!found.list.length && !retried) {         // maybe a brand-new PokPok label: check for a newer map once
      const before = currentStockMap() && currentStockMap().ver;
      await loadStockMap(true);
      if (currentStockMap() && currentStockMap().ver !== before) return handleScan(raw, true);
    }
    if (!found.list.length) {
      const known = codesForNumber(code);
      return showError(known.length
        ? `Label ${escapeHtml(code)} is <b>${known.map(escapeHtml).join(", ")}</b>, but that code is not in VHM Inventory yet · មិនទាន់មានក្នុង VHM Inventory`
        : `"${escapeHtml(code)}" is not in VHM Inventory · មិនមានក្នុង VHM Inventory`);
    }
    if (found.list.length > 1) { state.pick = { code, products: found.list }; beepStep(); buzz([60, 40, 60]); renderResult(); return; }
    state.lastScan = { code, t: Date.now() };
    move(found.list[0], code, found.variant);
  }

  function lockable() { return state.station !== "STOCK"; }
  // shown in the last live and not scanned anywhere since that live started = still out
  function liveOut(p) {
    const L = liveLast(), e = L && shownEntry(p);
    if (!e) return null;
    if (p.cycle_at && new Date(p.cycle_at) >= new Date(L.startedAt) && p.cycle_stage !== "LIVE") return null;
    return { ...e, liveId: L.id };
  }
  function stageOf(p) { return liveOut(p) ? "LIVE" : (p.cycle_stage || null); }

  async function move(product, scanned, variant) {
    const p = state.products.find(x => x.id === product.id) || product;
    if (state.station === "SHELF") {                 // 🏷 not a cycle move: set the stock shelf
      if (state.lock && state.lockedLoc) return saveShelf(p, state.lockedLoc);
      state.pending = { kind: "shelf", product: p, scanned }; state.last = null;
      beepStep(); buzz(25); renderStep(); renderResult(); input.focus(); return;
    }
    const from = stageOf(p);
    const to = state.station;
    if (from === to && to !== "SAMPLE") {         // (Sample → another container is allowed)
      beepWarn(); buzz([60, 40, 60]);
      state.last = { kind: "same", product: p, to };
      renderResult(); input.focus(); return;
    }
    // into Sample = into a sample container: needs its location (unless 📌 is holding one)
    if (to === "SAMPLE") {
      if (state.lock && state.lockedLoc) return commit(p, to, scanned, variant, state.lockedLoc);
      state.pending = { kind: "sample", product: p, scanned, variant }; state.last = null;
      beepStep(); buzz(25); renderStep(); renderResult(); input.focus(); return;
    }
    commit(p, to, scanned, variant, "");
  }

  async function commit(product, to, scanned, variant, location) {
    const p = state.products.find(x => x.id === product.id) || product;
    if (location && state.lock) state.lockedLoc = location;
    const { mv, patch, prev } = buildCycleMove(p, to, { scanned, station: state.station, variant, location, liveEntry: liveOut(p) });
    const { from, round, skipped } = mv;
    // show it at once; the save finishes in the background (works offline too — Firestore queues it)
    const entry = { logId: null, product: p, from, to, prev, t: new Date(), skipped, round, inFor: mv.in_from_ms, loc: mv.location, locWas: mv.location_was, saving: true };
    state.log.unshift(entry);
    state.last = { kind: "moved", entry };
    if (skipped) { beepWarn(); buzz([60, 40, 60]); } else { beepOk(); buzz(40); }
    renderResult(); renderLog(); input.focus();
    try {
      entry.logId = await logCycleMove(p, mv, patch);
      entry.saving = false;
    } catch (e) {
      entry.saving = false; entry.failed = true;
      state.lastScan = { code: "", t: 0 };        // let staff scan it again straight away
      beepBad(); buzz([200, 80, 200]);
      toast("Not saved: " + e.message, "error");
    }
    renderLog(); renderResult();
  }

  // ---------------- 🏷 shelf (stock location) ----------------
  async function saveShelf(product, raw, confirmed) {
    const p = state.products.find(x => x.id === product.id) || product;
    const field = LOCATION_FIELDS.stock, loc = norm(raw), from = p[field] || "";
    if (!loc) return;
    if (state.lock) state.lockedLoc = loc;
    if (norm(from) === loc) { beepOk(); state.last = { kind: "shelf", entry: { kind: "shelf", product: p, from, to: loc, same: true, t: new Date() } }; renderResult(); input.focus(); return; }
    // a shelf is already saved: never replace it without asking
    if (from && !confirmed) { state.confirm = { product: p, loc, from }; beepWarn(); buzz([60, 40, 60]); renderStep(); renderResult(); input.focus(); return; }
    const entry = { kind: "shelf", product: p, from, to: loc, t: new Date(), saving: true };
    state.log.unshift(entry); state.last = { kind: "shelf", entry };
    beepOk(); buzz(40); renderResult(); renderLog(); input.focus();
    try { await patchProduct(p.id, { [field]: loc }); entry.saving = false; }
    catch (e) { entry.saving = false; entry.failed = true; beepBad(); buzz([200, 80, 200]); toast("Not saved: " + e.message, "error"); }
    renderLog(); renderResult();
  }
  function keepShelf(silent) {
    const c = state.confirm; if (!c) return;
    state.confirm = null; state.lastScan = { code: "", t: 0 };
    state.last = { kind: "shelf", entry: { kind: "shelf", product: c.product, from: c.from, to: c.from, same: true, kept: c.loc, t: new Date() } };
    if (!silent) { renderStep(); renderResult(); input.focus(); }
  }

  function showError(html) {
    beepBad(); buzz([200, 80, 200]);
    state.last = null;
    $("#cy-result").innerHTML = `<div class="loc-msg loc-bad">✗ ${html}</div>`;
    input.focus();
  }

  // ---------------- screen ----------------
  function renderStations() {
    container.querySelectorAll(".cy-stations .live-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.st === state.station));
  }
  function renderStep() {
    const st = state.station;
    $("#cy-lock-wrap").hidden = !lockable();
    const shelf = state.pending?.kind === "shelf";
    input.placeholder = state.pending ? (shelf ? "Scan shelf, e.g. B23 · ស្កេនធ្នើ" : "Scan container location, e.g. S3 · ស្កេនទីតាំងប្រអប់") : "Scan product · ស្កេនទំនិញ";
    if (state.confirm) { $("#cy-step").innerHTML = `Replace or keep? Tap a button below · ប្តូរ ឬទុកដដែល?`; return; }
    if (state.pending) { $("#cy-step").innerHTML = `<b>Step 2 · ជំហានទី 2</b> — scan the ${shelf ? "📦 shelf" : "👕 sample container location"} for <b class="loc-big">${escapeHtml(state.pending.product.master_code)}</b> · ${shelf ? "ស្កេនធ្នើ" : "ស្កេនទីតាំងប្រអប់គំរូ"}`; return; }
    if (state.lock && state.lockedLoc && lockable()) { $("#cy-step").innerHTML = `📌 Filling ${st === "SHELF" ? "shelf" : "container"} <b class="loc-big">${escapeHtml(state.lockedLoc)}</b> — scan each product going in · ស្កេនទំនិញនីមួយៗ`; return; }
    if (st === "SHELF") { $("#cy-step").innerHTML = `<b>🏷 Set shelf</b> — scan the product, then its 📦 stock shelf (B23) · ស្កេនទំនិញ បន្ទាប់មកធ្នើ`; return; }
    $("#cy-step").innerHTML = st === "SAMPLE"
      ? `<b class="loc-big">👕 Put back</b> — scan the product, then its container (S3) · ស្កេនទំនិញ បន្ទាប់មកប្រអប់`
      : `<b class="loc-big">📦 To Stock</b> — the sample container is full: scan the piece, put it on its shelf · ប្រអប់គំរូពេញ`;
  }
  function whereToPut(p, stage) {
    if (stage === "STOCK") return `<div>Sample container full → kept in Stock as a replacement · កន្លែងគំរូពេញ ទុកក្នុងស្តុក</div>` + (p[LOCATION_FIELDS.stock] ? `<div>Put at 📦 <b class="loc-big">${escapeHtml(p[LOCATION_FIELDS.stock])}</b> · ដាក់នៅ</div>` : "");
    if (stage === "SAMPLE" && p[LOCATION_FIELDS.sample]) return `<div>Sample container 👕 <b class="loc-big">${escapeHtml(p[LOCATION_FIELDS.sample])}</b></div>`;
    return "";
  }
  function card(p, extra) {
    const cover = p.images?.[0]?.url || "";
    return `<div class="scan-item-card loc-card">
      ${cover ? `<img class="scan-item-img" src="${escapeHtml(cover)}" alt="" />` : ""}
      <div class="scan-item-body">
        <div><span class="master-code">${escapeHtml(p.master_code)}</span> — ${escapeHtml(p.name || "")}</div>
        ${extra || ""}
        <div><a href="#" class="loc-mapbtn cy-hist" data-id="${escapeHtml(p.id)}">History · ប្រវត្តិ</a></div>
      </div>
    </div>`;
  }
  function renderResult() {
    const el = $("#cy-result");
    if (state.pick) {
      el.innerHTML = `<div class="loc-msg loc-warn">🔀 Label <b>${escapeHtml(state.pick.code)}</b> is on ${state.pick.products.length} products — tap the one in your hand · ចុចទំនិញដែលនៅក្នុងដៃ</div>` +
        `<div class="rec-grid">${state.pick.products.map((p, i) => `<button type="button" class="rec-card loc-pick" data-i="${i}"><div class="rec-body"><strong>${escapeHtml(p.master_code)}</strong><span>${escapeHtml(p.name || "")}</span></div></button>`).join("")}</div>`;
      el.querySelectorAll(".loc-pick").forEach(b => b.onclick = () => { const p = state.pick.products[+b.dataset.i], code = state.pick.code; state.pick = null; state.lastScan = { code, t: Date.now() }; move(p, code); });
      return;
    }
    if (state.confirm) {
      const c = state.confirm;
      el.innerHTML = `<div class="loc-msg loc-warn">⚠ <b>${escapeHtml(c.product.master_code)}</b> already has 📦 <b class="loc-big">${escapeHtml(c.from)}</b> saved.<br>Replace it with <b class="loc-big">${escapeHtml(c.loc)}</b>? · មានធ្នើ ${escapeHtml(c.from)} រួចហើយ — ប្តូរទៅ ${escapeHtml(c.loc)}?
        <div class="loc-actions" style="margin-top:10px">
          <button type="button" class="btn btn-primary" id="cy-replace">Replace with ${escapeHtml(c.loc)} · ប្តូរ</button>
          <button type="button" class="btn btn-secondary" id="cy-keep">Keep ${escapeHtml(c.from)} · ទុកដដែល</button>
        </div></div>` + card(c.product);
      $("#cy-replace").onclick = () => { const x = state.confirm; state.confirm = null; renderStep(); saveShelf(x.product, x.loc, true); };
      $("#cy-keep").onclick = () => keepShelf(false);
      return;
    }
    if (state.pending) {
      const p = state.pending.product;
      el.innerHTML = state.pending.kind === "shelf"
        ? card(p, `<div class="muted">Shelf now: 📦 ${p[LOCATION_FIELDS.stock] ? escapeHtml(p[LOCATION_FIELDS.stock]) : "—"}</div><div>Now scan the shelf · ឥឡូវស្កេនធ្នើ</div>`)
        : card(p, `${p[LOCATION_FIELDS.sample] ? `<div class="muted">Last container: 👕 ${escapeHtml(p[LOCATION_FIELDS.sample])}</div>` : ""}<div>Now scan the container location · ឥឡូវស្កេនទីតាំងប្រអប់</div>`);
      el.querySelectorAll(".cy-hist").forEach(a => a.onclick = e => { e.preventDefault(); openHistory(a.dataset.id); });
      return;
    }
    const L = state.last;
    if (!L) { el.innerHTML = ""; return; }
    if (L.kind === "shelf") {
      const x = L.entry, p = state.products.find(q => q.id === x.product.id) || x.product;
      el.innerHTML = `<div class="loc-msg ${x.failed ? "loc-bad" : "loc-ok"}">${x.failed ? "✗" : "✓"} <b>${escapeHtml(p.master_code)}</b> 📦 ${x.same ? (x.kept ? `kept <b class="loc-big">${escapeHtml(x.to)}</b> <span class="muted">(not ${escapeHtml(x.kept)})</span>` : `already at <b class="loc-big">${escapeHtml(x.to)}</b>`) : `${x.from ? `${escapeHtml(x.from)} → ` : ""}<b class="loc-big">${escapeHtml(x.to)}</b>`}${x.saving ? ` <span class="muted">saving…</span>` : ""}${x.failed ? `<div>Not saved — scan again · មិនបានរក្សាទុក</div>` : ""}</div>` + card(p);
    } else if (L.kind === "same") {
      const p = state.products.find(x => x.id === L.product.id) || L.product;
      el.innerHTML = `<div class="loc-msg loc-warn">⚠ <b>${escapeHtml(p.master_code)}</b> is already in ${STAGES[L.to].icon} <b>${STAGES[L.to].en}</b> (since ${ago(p.cycle_at)}) — nothing logged · មាននៅទីនេះរួចហើយ</div>` + card(p, whereToPut(p, L.to));
    } else {
      const x = L.entry, p = state.products.find(q => q.id === x.product.id) || x.product, s = STAGES[x.to];
      const fromTxt = x.from ? `${STAGES[x.from].icon} ${STAGES[x.from].en}${x.inFor != null ? ` <span class="muted">(${ago(Date.now() - x.inFor)} there)</span>` : ""} → ` : "";
      const status = x.failed ? `<div class="loc-msg loc-bad" style="margin-top:6px">✗ Not saved — scan again · មិនបានរក្សាទុក</div>` : x.saving ? `<span class="muted">saving…</span>` : "";
      el.innerHTML = `<div class="loc-msg ${x.failed ? "loc-bad" : x.skipped ? "loc-warn" : "loc-ok"}">${x.failed ? "✗" : x.skipped ? "⚠" : "✓"} <b>${escapeHtml(p.master_code)}</b> ${fromTxt}<b class="loc-big">${s.icon} ${s.en}${x.to === "SAMPLE" && x.loc ? ` · ${escapeHtml(x.loc)}` : ""}</b>${x.locWas && norm(x.locWas) !== norm(x.loc) ? ` <span class="muted">(was ${escapeHtml(x.locWas)})</span>` : ""} ${x.round ? `<span class="muted">· 🎥 live ×${x.round}</span>` : ""}${status}</div>` + card(p, whereToPut(p, x.to));
    }
    el.querySelectorAll(".cy-hist").forEach(a => a.onclick = e => { e.preventDefault(); openHistory(a.dataset.id); });
  }
  function renderLog() {
    const el = $("#cy-log");
    if (!state.log.length) { el.innerHTML = ""; return; }
    el.innerHTML = `<h3 style="margin-top:20px;">This session · វគ្គនេះ (${state.log.length})</h3>
      <div class="loc-log">${state.log.slice(0, 60).map((x, i) => `<div class="loc-log-row${x.skipped ? " cy-row-skip" : ""}">
        <span class="master-code">${escapeHtml(x.product.master_code)}</span>
        ${x.kind === "shelf" ? `<span>🏷 📦 ${escapeHtml(x.from || "—")} → <b>${escapeHtml(x.to)}</b></span>` : `<span>${x.from ? STAGES[x.from].icon + " → " : ""}${STAGES[x.to].icon} <b>${STAGES[x.to].en}${x.to === "SAMPLE" && x.loc ? " · " + escapeHtml(x.loc) : ""}</b></span>`}
        <span class="muted">${hhmm(x.t.getTime())}</span>
        ${x.undone ? `<span class="muted">undone</span>` : x.failed ? `<span class="muted">not saved</span>` : x.saving ? `<span class="muted">saving…</span>` : `<button type="button" class="btn btn-secondary cy-undo" data-i="${i}">Undo · ដកវិញ</button>`}
      </div>`).join("")}</div>`;
    el.querySelectorAll(".cy-undo").forEach(b => b.onclick = async () => {
      const x = state.log[+b.dataset.i]; b.disabled = true;
      // only the newest move of a code can be undone safely (an older one would put back a stale stage)
      const newer = state.log.find(y => y !== x && (y.kind === "shelf") === (x.kind === "shelf") && y.product.id === x.product.id && !y.undone && !y.failed && y.t > x.t);
      if (newer) { toast(`Undo the newer ${x.product.master_code} ${x.kind === "shelf" ? "shelf change" : "move"} first`, "error"); b.disabled = false; return; }
      if (x.kind === "shelf") {
        try { await patchProduct(x.product.id, { [LOCATION_FIELDS.stock]: x.from || "" }); x.undone = true; if (state.last?.entry === x) state.last = null; toast(`${x.product.master_code} 📦 back to ${x.from || "—"}`); renderLog(); renderResult(); }
        catch (e) { toast("Undo failed: " + e.message, "error"); b.disabled = false; }
        return;
      }
      try { await undoCycleMove(x.logId, x.product.id, x.prev); x.undone = true; if (state.last?.entry === x) state.last = null; state.lastScan = { code: "", t: 0 }; toast(`${x.product.master_code} back to ${x.prev.cycle_stage ? STAGES[x.prev.cycle_stage].en : "—"}`); renderLog(); renderResult(); }
      catch (e) { toast("Undo failed: " + e.message, "error"); b.disabled = false; }
    });
  }
  function renderBoard() {
    const el = $("#cy-board"), f = state.boardFilter;
    const cols = ORDER.map(k => {
      const since = p => { const o = liveOut(p); return o ? o.last : p.cycle_at; };
      const items = state.products.filter(p => stageOf(p) === k && (!f || norm(p.master_code).includes(f)))
        .sort((a, b) => new Date(since(a)) - new Date(since(b)));   // longest there first
      const overdue = p => k === "LIVE" && Date.now() - new Date(since(p)).getTime() >= ROTATION_DAYS * 864e5;
      const nOver = items.filter(overdue).length;
      return `<div class="cy-col ${STAGES[k].cls}">
        <div class="cy-col-head">${STAGES[k].icon} ${STAGES[k].en} · ${STAGES[k].km}${k === "STOCK" ? " <span class='muted'>(replacement)</span>" : ""}${nOver ? ` <span class="cy-over-n" title="${ROTATION_DAYS}+ days in the Live Room — bring back">⏰ ${nOver}</span>` : ""} <b>${items.length}</b></div>
        ${items.length ? items.slice(0, 200).map(p => `<button type="button" class="cy-item${overdue(p) ? " cy-overdue" : ""}" data-id="${escapeHtml(p.id)}"${overdue(p) ? ` title="${ROTATION_DAYS}+ days in the Live Room — bring it back · យកត្រឡប់វិញ"` : ""}><span class="master-code">${overdue(p) ? "⏰ " : ""}${escapeHtml(p.master_code)}</span><span class="muted">${ago(since(p))}</span>${Number(p.cycle_round) ? `<span class="muted" title="Times in the Live Room">🎥×${Number(p.cycle_round)}</span>` : ""}</button>`).join("") : `<div class="muted cy-empty">—</div>`}
      </div>`;
    }).join("");
    el.innerHTML = cols;
    el.querySelectorAll(".cy-item").forEach(b => b.onclick = () => openHistory(b.dataset.id));
  }

  // ---------------- 🎥 Put back list (from VHM Live Log's last live) ----------------
  function renderPutback() {
    const el = $("#cy-putback"), L = liveLast(), err = liveError();
    if (!L) { el.innerHTML = `<div class="cy-pb-head"><b>🎥 Last live</b> <span class="muted">${escapeHtml(err || "loading…")}</span></div>`; return; }
    const st = new Date(L.startedAt), en = L.endedAt ? new Date(L.endedAt) : null;
    const day = st.toDateString() === new Date().toDateString() ? "today" : st.toLocaleDateString([], { day: "numeric", month: "short" });
    const rows = L.codes.map(c => {
      const code = norm(c.code), m = /^([A-Z]+)(\d{2})$/.exec(code);
      const p = state.byMaster.get(code) || (m && +m[2] >= 26 && +m[2] <= 46 ? state.byMaster.get(m[1]) : null);
      if (!p) return { c, kind: "none" };
      if (liveOut(p)) return { c, p, kind: "out" };
      return { c, p, kind: p.cycle_stage === "STOCK" ? "stock" : "back" };
    });
    const n = k => rows.filter(r => r.kind === k).length;
    const chip = r => r.kind === "out"
      ? `<button type="button" class="cy-pb cy-pb-out" data-id="${escapeHtml(r.p.id)}" title="Not back yet — last container ${escapeHtml(r.p[LOCATION_FIELDS.sample] || "—")}">⏳ ${escapeHtml(r.c.code)}${r.p[LOCATION_FIELDS.sample] ? ` <span>· ${escapeHtml(r.p[LOCATION_FIELDS.sample])}</span>` : ""}</button>`
      : r.kind === "none"
      ? `<span class="cy-pb cy-pb-none" title="This code is not in VHM Inventory">? ${escapeHtml(r.c.code)}</span>`
      : `<button type="button" class="cy-pb cy-pb-back" data-id="${escapeHtml(r.p.id)}">✓ ${escapeHtml(r.c.code)} <span>→ ${escapeHtml(r.kind === "stock" ? "Stock" : r.p[LOCATION_FIELDS.sample] || "Sample")}</span></button>`;
    const order = { out: 0, none: 1, back: 2, stock: 2 };
    el.innerHTML = `<div class="cy-pb-head"><b>🎥 Last live · ${day} ${hhmm(st.getTime())}${en ? "–" + hhmm(en.getTime()) : ""}</b>
        <span class="muted">${L.codes.length} shown</span>
        <span class="cy-pb-n cy-pb-n-out">⏳ ${n("out")} still out</span>
        <span class="cy-pb-n cy-pb-n-back">✓ ${n("back") + n("stock")} put back</span>
        ${n("none") ? `<span class="muted">· ${n("none")} not in VHM</span>` : ""}
        <a href="#" class="loc-mapbtn" id="cy-pb-check">check for a newer live</a>${err ? ` <span class="size-err">${escapeHtml(err)}</span>` : ""}</div>
      ${L.codes.length ? `<div class="cy-pb-list">${rows.sort((a, b) => order[a.kind] - order[b.kind]).map(chip).join("")}</div>` : `<div class="muted">No codes were sent to OBS in this live.</div>`}
      ${n("out") === 0 && L.codes.length ? `<div class="cy-pb-done">✓ Everything from this live is back · ដាក់វិញទាំងអស់ហើយ</div>` : ""}`;
    el.querySelector("#cy-pb-check").onclick = e => { e.preventDefault(); checkLive().then(() => toast(liveError() || "Up to date")); };
    el.querySelectorAll("button.cy-pb").forEach(b => b.onclick = () => openHistory(b.dataset.id));
  }

  // ---------------- 🎥 what to bring out next (from the old Live tab) ----------------
  // pieces waiting in 👕 Sample with the same category and a shared tag, used least first
  function nextUp(p) {
    const tags = p.tag_ids || [];
    const recs = state.products.filter(q => q.id !== p.id && q.cycle_stage === "SAMPLE" && q.category_id && q.category_id === p.category_id
        && (!tags.length || (q.tag_ids || []).some(t => tags.includes(t))))
      .sort((a, b) => (Number(a.cycle_round) || 0) - (Number(b.cycle_round) || 0) || new Date(a.cycle_at) - new Date(b.cycle_at))
      .slice(0, 8);
    if (!recs.length) return "";
    return `<h3 style="margin-top:16px;">Bring out next · យកចេញបន្ទាប់ <span class="muted" style="font-size:13px;font-weight:400">same category &amp; tag, waiting in 👕 Sample</span></h3>
      <div class="rec-grid">${recs.map(q => `<div class="rec-card">${q.images?.[0]?.url ? `<img src="${escapeHtml(q.images[0].url)}" alt="" loading="lazy" />` : ""}<div class="rec-body">
        <span class="master-code">${escapeHtml(q.master_code)}</span><strong>${escapeHtml(q.name || "")}</strong>
        <span class="muted">👕 ${escapeHtml(q[LOCATION_FIELDS.sample] || "—")} · 🎥 ×${Number(q.cycle_round) || 0} · in Sample ${ago(q.cycle_at)}</span></div></div>`).join("")}</div>`;
  }

  // ---------------- PokPok map status (PokPok labels → product codes) ----------------
  function renderMapInfo() {
    const el = $("#cy-map"), m = currentStockMap(), err = stockMapError();
    el.innerHTML = (m
      ? `🗺 PokPok labels: ${m.source === "online" ? "map from VHM Scan" : "map file"} · ${escapeHtml(String(m.at).slice(0, 16).replace("T", " "))} · ${m.count.toLocaleString()} items · `
      : `🗺 PokPok labels: no map yet · ផែនទីមិនទាន់មាន · `) +
      (err ? `<div class="loc-msg loc-${m ? "warn" : "bad"}" style="margin:6px 0">⚠ ${m ? "Using the copy on this device — " : ""}${escapeHtml(err.text)}</div>` : "") +
      `<a href="#" class="loc-mapbtn" id="cy-maprefresh">Check now</a> · <label class="loc-mapbtn">Open map file<input type="file" accept=".json,application/json" hidden id="cy-mapfile" /></label>`;
    el.querySelector("#cy-maprefresh").onclick = async e => { e.preventDefault(); await loadStockMap(true); renderMapInfo(); toast(stockMapError() ? "Map not updated" : "Map is up to date", stockMapError() ? "error" : "info"); input.focus(); };
    el.querySelector("#cy-mapfile").onchange = async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      try { await useMapFile(JSON.parse(await f.text())); renderMapInfo(); toast("Map file loaded"); } catch (err2) { toast(err2.message, "error"); }
      input.focus();
    };
  }

  // ---------------- printable location barcodes (shelves / containers) ----------------
  function printLocationLabels() {
    const txt = prompt("Locations to print (comma or space separated) · ទីតាំងសម្រាប់ព្រីន", lsGet("labels", STORAGE_LOCATIONS.join(", ")));
    if (txt == null) return;
    lsSet("labels", txt);
    const locs = [...new Set(txt.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (!locs.length) return;
    const w = window.open("", "_blank");
    if (!w) { toast("Allow pop-ups to print labels", "error"); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Location labels</title>
      <style>body{font-family:system-ui,sans-serif;margin:10mm}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(60mm,1fr));gap:6mm}
      .l{border:1px dashed #999;border-radius:3mm;padding:3mm;text-align:center;break-inside:avoid}.l b{display:block;font-size:28pt;line-height:1.1}svg{width:100%;height:22mm}
      @media print{.no{display:none}}</style></head><body>
      <p class="no"><button onclick="print()">🖨 Print</button> — each label is a barcode of the location (scan it in VHM Inventory → 📍 Scan).</p>
      <div class="g">${locs.map(l => `<div class="l"><b>${escapeHtml(l)}</b><svg class="bc" data-v="${escapeHtml(l)}"></svg></div>`).join("")}</div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"><\/script>
      <script>document.querySelectorAll('.bc').forEach(function(s){ JsBarcode(s, s.dataset.v, { format: 'CODE128', displayValue: false, margin: 0, height: 60 }); });<\/script>
      </body></html>`);
    w.document.close();
  }

  // ---------------- history of one code ----------------
  async function openHistory(productId) {
    const p = state.products.find(x => x.id === productId);
    const ov = modal(`History · ប្រវត្តិ — ${escapeHtml(p?.master_code || "")}`, `<p class="muted">Loading…</p>`);
    try {
      const rows = await listCycleLogForProduct(productId);
      const lives = rows.filter(r => r.to === "LIVE").length;
      ov.body.innerHTML = rows.length
        ? `<p class="muted">${rows.length} moves · 🎥 in the Live Room ${lives}× · now ${p?.cycle_stage ? STAGES[p.cycle_stage].icon + " " + STAGES[p.cycle_stage].en : "—"}</p>${logTable(rows, false)}`
        : `<p class="muted">No moves logged for this code yet.</p>`;
    } catch (e) { ov.body.innerHTML = `<div class="loc-msg loc-bad">✗ ${escapeHtml(e.message)}</div>`; }
  }

  // ---------------- day log (+ CSV) ----------------
  async function openDayLog(dayStr) {
    const today = new Date(); const pad = n => String(n).padStart(2, "0");
    dayStr = dayStr || `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const ov = modal(`Day log · កំណត់ត្រាប្រចាំថ្ងៃ`, ``);
    ov.body.innerHTML = `<div class="loc-actions"><input type="date" id="cy-date" value="${dayStr}" /><button class="btn btn-secondary" id="cy-csv" disabled>⬇ CSV</button></div><div id="cy-dayrows"><p class="muted">Loading…</p></div>`;
    const load = async () => {
      const d = ov.body.querySelector("#cy-date").value; if (!d) return;
      const [y, m, dd] = d.split("-").map(Number), start = new Date(y, m - 1, dd).getTime(), end = start + 864e5;
      const box = ov.body.querySelector("#cy-dayrows"), csvBtn = ov.body.querySelector("#cy-csv");
      box.innerHTML = `<p class="muted">Loading…</p>`; csvBtn.disabled = true;
      try {
        const rows = await listCycleLogBetween(start, end);
        const count = k => rows.filter(r => r.to === k).length;
        box.innerHTML = rows.length
          ? `<p class="muted">${rows.length} moves · to 🎥 Live ${count("LIVE")} · to 👕 Sample ${count("SAMPLE")} · to 📦 Stock (sample full) ${count("STOCK")}</p>${logTable(rows, true)}`
          : `<p class="muted">No moves on this day.</p>`;
        csvBtn.disabled = !rows.length;
        csvBtn.onclick = () => downloadCsv(rows, d);
      } catch (e) { box.innerHTML = `<div class="loc-msg loc-bad">✗ ${escapeHtml(e.message)}</div>`; }
    };
    ov.body.querySelector("#cy-date").onchange = load;
    load();
  }
  function logTable(rows, withCode) {
    return `<div class="cy-table-wrap"><table class="variant-inline-table cy-table"><thead><tr><th>Time</th>${withCode ? "<th>Code</th>" : ""}<th>Move</th><th>Was there</th><th>Live #</th><th>By</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.skipped ? "cy-row-skip" : ""}">
        <td data-label="Time">${new Date(r.at_ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        ${withCode ? `<td data-label="Code"><span class="master-code">${escapeHtml(r.master_code)}</span></td>` : ""}
        <td data-label="Move">${r.from ? STAGES[r.from]?.icon + " → " : ""}${STAGES[r.to]?.icon || ""} ${STAGES[r.to]?.en || escapeHtml(r.to)}${r.location ? " · " + escapeHtml(r.location) : ""}</td>
        <td data-label="Was there">${r.in_from_ms != null ? ago(Date.now() - r.in_from_ms) : "—"}</td>
        <td data-label="Live #">${r.round ?? ""}</td>
        <td data-label="By" class="muted">${escapeHtml((r.by || "").split("@")[0])}</td>
      </tr>`).join("")}</tbody></table></div>`;
  }
  function downloadCsv(rows, day) {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["time", "code", "from", "to", "minutes_in_previous_stage", "times_live", "reason", "location", "scanned", "size", "color", "by"];
    const lines = rows.slice().reverse().map(r => [new Date(r.at_ms).toISOString(), r.master_code, r.from || "", r.to, r.in_from_ms != null ? Math.round(r.in_from_ms / 60000) : "", r.round, r.reason || "", r.location || "", r.scanned, r.variant?.size, r.variant?.color, r.by].map(esc).join(","));
    const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `vhm-cycle-log-${day}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function modal(title, html) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<div class="modal"><div class="modal-header"><h2>${title}</h2><button class="btn-icon modal-close">&times;</button></div><div class="modal-body">${html}</div></div>`;
    document.body.appendChild(ov);
    const close = () => { ov.remove(); input.focus(); };
    ov.querySelector(".modal-close").onclick = close;
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    return { el: ov, body: ov.querySelector(".modal-body") };
  }

  // ---------------- printable station barcodes ----------------
  function printStationLabels() {
    const w = window.open("", "_blank");
    if (!w) { toast("Allow pop-ups to print labels", "error"); return; }
    const labels = [{ v: "SAMPLE", t: "👕 Put back", km: "ដាក់វិញ" }, { v: "STOCK", t: "📦 To Stock", km: "ទៅស្តុក" }, { v: "SHELF", t: "🏷 Set shelf", km: "កំណត់ធ្នើ" }];
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Station labels</title>
      <style>body{font-family:system-ui,sans-serif;margin:10mm}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(80mm,1fr));gap:8mm}
      .l{border:1px dashed #999;border-radius:3mm;padding:4mm;text-align:center;break-inside:avoid}.l b{display:block;font-size:26pt;line-height:1.2}.l i{display:block;font-style:normal;font-size:14pt}svg{width:100%;height:24mm}
      @media print{.no{display:none}}</style></head><body>
      <p class="no"><button onclick="print()">🖨 Print</button> — stick each one at its station. Scanning it in VHM Inventory → 📍 Scan switches the station.</p>
      <div class="g">${labels.map(l => `<div class="l"><b>${l.t}</b><i>${l.km}</i><svg class="bc" data-v="${l.v}"></svg></div>`).join("")}</div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"><\/script>
      <script>document.querySelectorAll('.bc').forEach(function(s){ JsBarcode(s, s.dataset.v, { format: 'CODE128', displayValue: true, fontSize: 14, margin: 0, height: 60 }); });<\/script>
      </body></html>`);
    w.document.close();
  }

  renderStations(); renderStep(); renderBoard(); renderPutback();
  setTimeout(() => input.focus(), 0);
  renderMapInfo();
  return () => { unsub(); stopMap(); stopLive(); clearInterval(ticker); clearInterval(liveTicker); };
}
