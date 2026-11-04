// ============================================================================
// live-feed.js — the last live from VHM Live Log, for the 📍 Scan tab's
// "Put back" list.
//
// Live Log (live.html, vhm-catalog project) has ⏺ Start live / ⏹ End live.
// While live, the codes sent to OBS / copied are kept on that computer; End live
// saves ONE record: kv/live_last (+ kv/live_session:<id> as history), shaped
//   { id, startedAt, endedAt, by, codes: [{ code, first, last, n }] }
// This file reads kv/live_last with the same public read access the phone relay
// uses. Cost: 1 read when the Scan tab opens and every 5 minutes while it is on
// screen; the record is kept on the device.
// ============================================================================

const URL_LAST = "https://firestore.googleapis.com/v1/projects/vhm-catalog/databases/(default)/documents/kv/live_last?key=AIzaSyDDQp5_gvuRdX0flKQ3gm3zXJM_SXWUJSE";
const LS = "vhminv_live_last_v1";
const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();

let last = null, err = "", checking = null;
try { last = JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) {}
const listeners = new Set();
export const onLive = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const liveLast = () => last;
export const liveError = () => err;

// Firestore REST typed value → plain JS
export function plain(v) {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plain);
  if ("mapValue" in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = plain(x); return o; }
  return null;
}

export function checkLive() {
  if (checking) return checking;
  checking = (async () => {
    try {
      const r = await fetch(URL_LAST);
      if (r.status === 404) { err = "No live sent yet — press ⏺ Start live / ⏹ End live in VHM Live Log"; return; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const doc = await r.json();
      let data = plain(doc.fields?.data);
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
      if (!data || !data.id || !Array.isArray(data.codes)) throw new Error("unexpected live record");
      err = "";
      if (!last || last.id !== data.id || last.endedAt !== data.endedAt) {
        last = data;
        try { localStorage.setItem(LS, JSON.stringify(last)); } catch (e) {}
      }
    } catch (e) { err = "Last live not updated: " + e.message; }
    finally { checking = null; listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } }); }
  })();
  return checking;
}

// The shown entry for a VHM product: its master code, or old pants saved as one
// product (JC) whose live code carried the waist (JC29).
export function shownEntry(product) {
  if (!last || !product) return null;
  const mc = norm(product.master_code);
  for (const c of last.codes) {
    const code = norm(c.code);
    if (code === mc) return c;
    const m = /^([A-Z]+)(\d{2})$/.exec(code);
    if (m && m[1] === mc && +m[2] >= 26 && +m[2] <= 46) return c;
  }
  return null;
}

// Shown in the last live and not scanned anywhere since that live started = still
// out in the Live Room (same rule as the 📍 Scan tab's "Put back" list).
export function liveOutOf(product) {
  const L = last, e = L && shownEntry(product);
  if (!e) return null;
  if (product.cycle_at && new Date(product.cycle_at) >= new Date(L.startedAt) && product.cycle_stage !== "LIVE") return null;
  return { ...e, liveId: L.id };
}
