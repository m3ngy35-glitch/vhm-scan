// ============================================================================
// stock-sizes.js — "which sizes are in stock" from Vrich, for the product cards
// and size search (S / M / L / 32 …).
//
// Where it comes from: the staff "Copy Stock" bookmarklet on the Vrich Sale page
// (tools/copy-stock-bookmarklet.src.js). Besides the phone relay it saves a
// compact snapshot — code → [colour, size, remain] — to the vhm-catalog project:
//   kv/vhm_sizes_meta  { hash, at, codes }        tiny: checked here
//   kv/vhm_sizes       { data: gzip+base64 JSON }  downloaded only when hash changed
// Remain = Sale-page quantity − orders (an order reserves the piece at once, paid
// or not) + stock not added to the sale yet. No cost or price is in it.
//
// Firestore cost (vhm-catalog, not vhm-data): 1 read when the app opens and every
// 5 minutes while it is open; +1 read only when the stock really changed. The
// snapshot is kept on this device, so a reopen with no change downloads nothing.
// ============================================================================

const BASE = "https://firestore.googleapis.com/v1/projects/vhm-catalog/databases/(default)/documents/kv/";
const KEY = "?key=AIzaSyDDQp5_gvuRdX0flKQ3gm3zXJM_SXWUJSE";
const LS = "vhminv_sizes_v1";
const CHECK_MS = 5 * 60 * 1000;
export const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "5XL", "6XL", "F", "FS", "FREE", "FREESIZE"];
const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|\d{2})$/i;
export const normSize = s => { s = String(s || "").trim().toUpperCase(); return s === "XXL" ? "2XL" : s === "XXXL" ? "3XL" : s; };
const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();

let snap = null;            // { hash, at, byCode: Map(code → rows), byBase: Map(base → rows) }
let lastErr = "";
const listeners = new Set();
let timer = null, checking = null;

export const sizesLoaded = () => !!snap;
export const sizesAt = () => snap && snap.at;
export const sizesError = () => lastErr;
export function onSizes(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });

// a pants waist only counts as a size from 26 to 46 (so "10" or "99" stay normal search words)
export function isSizeTerm(t) { t = String(t || "").trim(); return SIZE_RE.test(t) && (!/^\d+$/.test(t) || (+t >= 26 && +t <= 46)); }

function build(hash, at, body) {
  const byCode = new Map(), byBase = new Map();
  for (const [code, rows] of Object.entries(body || {})) {
    const list = rows.map(r => ({ colour: r[0] || "", size: normSize(r[1]), qty: +r[2] || 0, base: r[3] || "" }));
    byCode.set(norm(code), list);
    list.forEach(r => { if (r.base) { const b = norm(r.base); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(r); } });
  }
  return { hash, at, byCode, byBase };
}

export async function gunzip64(b64) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(s).text();
}
const field = (doc, k) => { const f = doc?.fields?.[k]; return f ? (f.stringValue ?? f.timestampValue ?? f.integerValue ?? "") : ""; };

export function startSizes() {
  if (!snap) {
    try {
      const c = JSON.parse(localStorage.getItem(LS) || "null");
      if (c && c.hash && c.body) { snap = build(c.hash, c.at, c.body); emit(); }
    } catch (e) {}
  }
  if (!timer) {
    checkSizes();
    timer = setInterval(() => { if (!document.hidden) checkSizes(); }, CHECK_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && snap && Date.now() - (snap.checkedAt || 0) > CHECK_MS) checkSizes(); });
  }
}

export function checkSizes() {
  if (checking) return checking;
  checking = (async () => {
    try {
      const metaRes = await fetch(BASE + "vhm_sizes_meta" + KEY);
      if (metaRes.status === 404) { lastErr = "No stock sizes yet — click Copy Stock on the Vrich Sale page once"; emit(); return; }
      if (!metaRes.ok) throw new Error("meta " + metaRes.status);
      const meta = await metaRes.json(), hash = field(meta, "hash"), at = field(meta, "at");
      if (snap && snap.hash === hash) { snap.checkedAt = Date.now(); lastErr = ""; return; }
      const res = await fetch(BASE + "vhm_sizes" + KEY);
      if (!res.ok) throw new Error("data " + res.status);
      const doc = await res.json();
      const body = JSON.parse(await gunzip64(field(doc, "data")));
      snap = build(field(doc, "hash") || hash, field(doc, "at") || at, body);
      snap.checkedAt = Date.now(); lastErr = "";
      try { localStorage.setItem(LS, JSON.stringify({ hash: snap.hash, at: snap.at, body })); } catch (e) {}
      emit();
    } catch (e) {
      lastErr = "Stock sizes not updated: " + e.message; console.warn(lastErr); emit();
    } finally { checking = null; }
  })();
  return checking;
}

// rows for one VHM product: its master code exactly, else old pants saved as one
// product (AA) whose Vrich codes are AA28 / AA29 … (the size is the code's number)
export function stockRows(product) {
  if (!snap || !product) return null;
  const code = norm(product.master_code);
  return snap.byCode.get(code) || snap.byBase.get(code) || null;
}

// the whole current snapshot (every Vrich code, matched to VHM or not) — for the 📊 Dashboard
export const sizesSnapshot = () => snap;
// sort rank for a size: S M L … then waist 28 29 30 …
export const sizeRank = s => { const i = SIZE_ORDER.indexOf(s); return i >= 0 ? i : /^\d+$/.test(s) ? 100 + +s : 500; };

// { size → total remain } in a sensible order (S M L … then 28 29 30 …)
export function sizeTotals(rows) {
  const t = new Map();
  (rows || []).forEach(r => { const k = r.size || "—"; t.set(k, (t.get(k) || 0) + r.qty); });
  return [...t.entries()].sort((a, b) => sizeRank(a[0]) - sizeRank(b[0]));
}

export function hasSizeInStock(product, sizes) {
  const rows = stockRows(product);
  if (!rows) return false;
  const want = sizes.map(normSize);
  return rows.some(r => r.qty > 0 && want.includes(r.size));
}

export function stockAgo() {
  if (!snap?.at) return "";
  const m = Math.round((Date.now() - new Date(snap.at).getTime()) / 60000);
  const t = new Date(snap.at);
  const hh = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return m < 1 ? `${hh} (now)` : m < 60 ? `${hh} (${m} min ago)` : m < 1440 ? `${hh} (${Math.floor(m / 60)}h ago)` : `${t.getDate()}/${t.getMonth() + 1} ${hh}`;
}
