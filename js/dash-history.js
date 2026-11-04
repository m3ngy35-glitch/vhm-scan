// ============================================================================
// dash-history.js — the past, for the 📊 Dashboard (vhm-catalog project, read-only).
//
//   kv/vhm_sizes_day:<YYYY-MM-DD>     the first stock snapshot of each day (written
//                                    by the Copy Stock bookmarklet, ~1 write/day)
//   kv/live_session:<YYYY-MM-DD_HHMM> one per live (written by VHM Live Log ⏹ End live)
//
// Both kinds never change once written, so this device keeps every one it has
// downloaded (IndexedDB) and only asks Firestore for what it doesn't have yet:
//   - days: one batchGet for the missing days of the last DAYS days
//     (a past day that wasn't there is remembered as "none" — it can't appear later)
//   - lives: one query for live_session docs newer than the newest one kept here
// Cost per dashboard open: usually 2 reads (today's day doc + "any new live?").
// ============================================================================

import { gunzip64, normSize } from "./stock-sizes.js";
import { plain } from "./live-feed.js";

const ROOT = "projects/vhm-catalog/databases/(default)/documents";
const API = "https://firestore.googleapis.com/v1/" + ROOT;
const KEY = "?key=AIzaSyDDQp5_gvuRdX0flKQ3gm3zXJM_SXWUJSE";
export const DAYS = 14;          // days of stock history used (best sellers / runs out / live effect)
const LIVE_DAYS = 45;            // first download: lives from the last 45 days

const pad = n => String(n).padStart(2, "0");
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();

// ---- tiny IndexedDB store (one per app, separate from the product cache) ----
const idb = {
  open() { return this._p || (this._p = new Promise((res, rej) => { const r = indexedDB.open("vhminv_dash", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); },
  async get(k) { try { const d = await this.open(); return await new Promise(res => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const d = await this.open(); return await new Promise(res => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); } catch (e) { return false; } },
};

const field = (doc, k) => { const f = doc?.fields?.[k]; return f ? (f.stringValue ?? f.timestampValue ?? f.integerValue ?? "") : ""; };

// gzip+base64 snapshot → [{ code, colour, size, qty, base }]
async function decodeDay(b64) {
  const body = JSON.parse(await gunzip64(b64));
  const out = [];
  for (const [code, rows] of Object.entries(body || {}))
    rows.forEach(r => out.push({ code: norm(code), colour: r[0] || "", size: normSize(r[1]), qty: +r[2] || 0, base: norm(r[3] || "") }));
  return out;
}

// ---- stock history: [{ day, at, rows }] oldest first ----
export async function loadDays() {
  const today = new Date(), want = [];
  for (let i = DAYS; i >= 0; i--) want.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  const todayKey = want[want.length - 1];
  const cached = await Promise.all(want.map(d => idb.get("day:" + d)));
  const missing = want.filter((d, i) => !cached[i] || (cached[i].none && d === todayKey));
  let err = "";
  if (missing.length) {
    try {
      const r = await fetch(API + ":batchGet" + KEY, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: missing.map(d => `${ROOT}/kv/vhm_sizes_day:${d}`) }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const res = await r.json();
      for (const x of res) {
        const name = x.found?.name || x.missing || "", d = name.split("vhm_sizes_day:")[1];
        if (!d) continue;
        const v = x.found ? { b64: field(x.found, "data"), at: field(x.found, "at") || `${d}T00:00:00` } : { none: true };
        cached[want.indexOf(d)] = v;
        if (x.found || d !== todayKey) await idb.set("day:" + d, v);   // today "not yet" is asked again next open
      }
    } catch (e) { err = "Stock history not updated: " + e.message; }
  }
  const days = [];
  for (let i = 0; i < want.length; i++) {
    const c = cached[i];
    if (!c || c.none || !c.b64) continue;
    try { days.push({ day: want[i], at: new Date(c.at).getTime(), rows: await decodeDay(c.b64) }); } catch (e) { console.warn("day", want[i], e); }
  }
  return { days, err };
}

// ---- live sessions: [{ id, startedAt, endedAt, codes: [{ code, first, last, n }] }] oldest first ----
export async function loadLives() {
  const kept = (await idb.get("lives")) || [];
  const newest = kept.length ? kept[kept.length - 1].id : "";
  const from = newest || (() => { const d = new Date(Date.now() - LIVE_DAYS * 864e5); return `${dayKey(d)}_0000`; })();
  let err = "";
  try {
    const ref = id => ({ referenceValue: `${ROOT}/kv/live_session:${id}` });
    const r = await fetch(API + ":runQuery" + KEY, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: "kv" }],
        where: { compositeFilter: { op: "AND", filters: [
          { fieldFilter: { field: { fieldPath: "__name__" }, op: newest ? "GREATER_THAN" : "GREATER_THAN_OR_EQUAL", value: ref(from) } },
          { fieldFilter: { field: { fieldPath: "__name__" }, op: "LESS_THAN", value: { referenceValue: `${ROOT}/kv/live_session;` } } },
        ] } },
        orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
        limit: 300,
      } }) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const res = await r.json();
    let added = 0;
    for (const x of res) {
      if (!x.document) continue;
      let data = plain(x.document.fields?.data);
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { continue; } }
      if (!data || !Array.isArray(data.codes)) continue;
      const id = data.id || x.document.name.split("live_session:")[1];
      if (kept.some(k => k.id === id)) continue;
      kept.push({ id, startedAt: data.startedAt, endedAt: data.endedAt || data.startedAt, codes: data.codes.map(c => ({ code: norm(c.code), first: c.first, last: c.last, n: +c.n || 1 })) });
      added++;
    }
    if (added) {
      kept.sort((a, b) => (a.id < b.id ? -1 : 1));
      const cutoff = Date.now() - 120 * 864e5;            // keep ~4 months on the device
      await idb.set("lives", kept.filter(k => new Date(k.startedAt).getTime() > cutoff));
    }
  } catch (e) { err = "Live history not updated: " + e.message; }
  return { lives: kept, err };
}
