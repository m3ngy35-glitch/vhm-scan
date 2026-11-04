// ============================================================================
// dashboard-tab.js — the 📊 Dashboard tab: what to DO today, from data we
// already collect. Read-only (the only button, "Mark pulled", is a tick kept on
// this device — no Firestore write).
//
//   1  Pull out — sold out in Vrich but the piece is still in a sample container
//      / the Live Room
//   2  Broken size runs — core sizes (M L XL / waist 30–32) at 0, other sizes left
//   3  Put on live next — in stock, not shown in a live for 14+ days (or never)
//   4  Pieces left by size                                     (desktop)
//   5  Best sellers · 7 days            ← needs the daily history (desktop)
//   6  Runs out soon                    ← needs the daily history (desktop)
//   7  Does going live sell it?         ← history + live sessions (desktop)
// Phone = header, 4 tiles, sections 1–3 ("Show charts" opens the rest).
//
// Data (nothing new is listened to):
//   - Vrich stock snapshot: stock-sizes.js (already checked every 5 min by the app)
//   - VHM products: the Products tab's live list (productWatchers in app.js)
//   - last live: live-feed.js (1 read on open); live history + daily stock history:
//     dash-history.js, read once per open, kept on the device
// Vrich codes ↔ VHM products: exact master code, else old pants AA28 → AA.
// Codes with no match are listed at the bottom, never counted as 0 stock.
// ============================================================================

import { sizesSnapshot, onSizes, stockAgo, sizesError, checkSizes, sizeRank } from "./stock-sizes.js";
import { checkLive, liveLast, onLive, liveOutOf, liveError } from "./live-feed.js";
import { loadDays, loadLives, DAYS } from "./dash-history.js";
import { LOCATION_FIELDS } from "./constants.js";
import { escapeHtml, toast } from "./ui-components.js";
import { parseGuide, fitRange, normalizeGuideSize, WEIGHT_BANDS, rangeFitsBand } from "./weight-guide.js";

// ---- settings (owner decisions — see the handoff) ----
// Is the sample piece counted in Vrich stock? true → "0 left" means even the sample
// was ordered, so section 1 says "pull it and pack it for the customer".
const SAMPLE_COUNTED = true;
const CORE_LETTER = ["M", "L", "XL"];
const CORE_WAIST = ["30", "31", "32"];
const LETTER_BARS = ["S", "M", "L", "XL", "2XL", "3XL", "4XL"];
const WAIST_BARS = ["28", "29", "30", "31", "32", "33", "34", "35", "36"];
const NOT_LIVE_DAYS = 14;
const LEFTOVER_PUSH = 6;      // this few pieces left → "push the leftovers on live" instead of "restock"
const RUNOUT_DAYS = 7;        // "runs out soon" = at this week's speed, gone within this many days
const LIVE_EFFECT_DAYS = 3;   // "pieces ordered in the 3 days after a code was shown"
const LIST_CAP = 12;          // rows shown per list before "Show all"

const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();
const LS = "vhminv_dash_";
const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {} };
const DAY = 864e5;
const fmt = n => Math.round(n).toLocaleString("en-US");
function ago(t) {
  const ms = Date.now() - (typeof t === "number" ? t : new Date(t).getTime());
  if (!isFinite(ms)) return "";
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
const shortDate = t => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function initDashboardTab(container, { getProducts, onProducts, getCategories, openProduct }) {
  const S = {
    products: [], byMaster: new Map(),
    cat: lsGet("cat", ""),
    days: [], lives: [], histErr: "", livesErr: "", histLoading: true,
    pulled: lsGet("pulled", {}),          // productId → ISO time ticked on this device
    open: {},                             // section id → "Show all" open
    more: false,                          // phone: show the desktop sections too
    dirty: true,
  };

  container.innerHTML = `<div class="dash"><div id="dash-head"></div><div id="dash-body"><p class="muted">Loading…</p></div></div>`;
  const $ = s => container.querySelector(s);

  // ---------------- data ----------------
  function useProducts(list) {
    S.products = (list || []).filter(p => !p.deleted);
    S.byMaster = new Map(S.products.map(p => [norm(p.master_code), p]));
    schedule();
  }
  function productFor(code, base) {
    code = norm(code);
    const p = S.byMaster.get(code) || (base && S.byMaster.get(norm(base)));
    if (p) return p;
    const m = /^([A-Z]+)(\d{2})$/.exec(code);
    return m && +m[2] >= 26 && +m[2] <= 46 ? S.byMaster.get(m[1]) || null : null;
  }
  const keyOf = (code, base) => { const p = productFor(code, base); return p ? "p:" + p.id : "c:" + norm(code); };

  async function loadHistory() {
    S.histLoading = true; schedule();
    const [d, l] = await Promise.all([loadDays(), loadLives()]);
    S.days = d.days; S.histErr = d.err; S.lives = l.lives; S.livesErr = l.err;
    S.histLoading = false; schedule();
  }
  function refresh() {
    toast("Checking… · កំពុងពិនិត្យ");
    Promise.all([checkSizes(), checkLive(), loadHistory()]).then(() => toast(sizesError() || liveError() || S.histErr || S.livesErr || "Up to date · ថ្មីហើយ"));
  }

  // ---------------- the numbers ----------------
  function compute() {
    const snap = sizesSnapshot();
    if (!snap) return null;
    // items = one per VHM product (old pants AA28/AA29… merged), or per unmatched Vrich code
    const items = new Map();
    for (const [code, rows] of snap.byCode) {
      const base = rows.find(r => r.base)?.base || "";
      const p = productFor(code, base), key = p ? "p:" + p.id : "c:" + code;
      let it = items.get(key);
      if (!it) items.set(key, it = { key, product: p, code: p ? p.master_code : code, vcodes: [], rows: [], total: 0 });
      it.vcodes.push(code);
      rows.forEach(r => { it.rows.push({ ...r, code }); it.total += r.qty; });
    }
    for (const it of items.values()) {
      const t = new Map();
      it.rows.forEach(r => t.set(r.size || "—", (t.get(r.size || "—") || 0) + r.qty));
      it.sizes = [...t.entries()].sort((a, b) => sizeRank(a[0]) - sizeRank(b[0]));
      it.guide = parseGuide(it.product?.description || "");
      it.fit = fitRange(it.rows, it.guide);
    }
    const all = [...items.values()];
    const inCat = it => !S.cat || it.product?.category_id === S.cat;
    const list = all.filter(inCat);
    const matchedIds = new Set(all.filter(i => i.product).map(i => i.product.id));

    // ---- history points: each day's first snapshot + the current one ----
    const points = S.days.filter(d => d.at < new Date(snap.at).getTime() - 60000).map(d => {
      const v = new Map(), it = new Map();
      d.rows.forEach(r => { const k = keyOf(r.code, r.base); const vk = `${k}|${r.colour}|${r.size}`; v.set(vk, (v.get(vk) || 0) + r.qty); it.set(k, (it.get(k) || 0) + r.qty); });
      return { at: d.at, v, it };
    });
    { const v = new Map(), itm = new Map();
      all.forEach(i => i.rows.forEach(r => { const vk = `${i.key}|${r.colour}|${r.size}`; v.set(vk, (v.get(vk) || 0) + r.qty); itm.set(i.key, (itm.get(i.key) || 0) + r.qty); }));
      points.push({ at: new Date(snap.at).getTime(), v, it: itm, now: true }); }
    // drops between consecutive points = ordered (an increase = restock → ignored)
    const drops = [];
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k].v, b = points[k + 1].v, byItem = new Map(), byVar = new Map();
      let restocks = 0;
      for (const [vk, q0] of a) {
        if (!b.has(vk)) continue;                         // left the sale list — not an order
        const d = q0 - b.get(vk);
        if (d > 0) { byVar.set(vk, d); const ik = vk.split("|")[0]; byItem.set(ik, (byItem.get(ik) || 0) + d); }
        else if (d < 0) restocks++;
      }
      drops.push({ byItem, byVar, restocks });
    }
    const orderedItem = (key, i, j) => { let s = 0; for (let k = i; k < j; k++) s += drops[k].byItem.get(key) || 0; return s; };

    // 7-day window
    const tNow = points[points.length - 1].at;
    let i0 = points.findIndex(p => p.at >= tNow - 7 * DAY - 6 * 3600e3);
    if (i0 < 0 || i0 === points.length - 1) i0 = -1;
    const hist = i0 >= 0 ? { i0, span: (tNow - points[i0].at) / DAY, from: points[i0].at } : null;

    // ---- 1 pull out ----
    const pull = [], pulledDone = [];
    for (const it of list) {
      const p = it.product;
      if (!p || it.total > 0 || !it.rows.length) continue;
      const out = liveOutOf(p);
      let where = null;
      if (out) where = { kind: "live", label: "🎥 Live Room", since: new Date(out.last || liveLast()?.endedAt || Date.now()).getTime() };
      else if (p.cycle_stage === "LIVE") where = { kind: "live", label: "🎥 Live Room", since: new Date(p.cycle_at).getTime() };
      else if (p.cycle_stage === "SAMPLE" || (!p.cycle_stage && p[LOCATION_FIELDS.sample])) where = { kind: "sample", label: `👕 ${p[LOCATION_FIELDS.sample] || "Sample"}`, since: p.cycle_at ? new Date(p.cycle_at).getTime() : null };
      else if (p.cycle_stage === "STOCK") where = { kind: "stock", label: `📦 ${p[LOCATION_FIELDS.stock] || "Stock"} (replacement)`, since: p.cycle_at ? new Date(p.cycle_at).getTime() : null };
      if (!where) continue;
      const row = { it, p, where };
      (S.pulled[p.id] ? pulledDone : pull).push(row);
    }
    pull.sort((a, b) => (a.where.kind === "live" ? 0 : 1) - (b.where.kind === "live" ? 0 : 1) || (a.where.since || 0) - (b.where.since || 0));

    // ---- 2 broken size runs (weight guide wins; old core-size rule is fallback) ----
    const broken = [];
    for (const it of list) {
      if (!it.total) continue;
      const sz = new Map(it.sizes.map(([s, q]) => [normalizeGuideSize(s), q]));
      const hasMadeList = it.guide.madeSizes.size > 0;
      const guided = it.guide.weights.size > 0;
      const expected = hasMadeList
        ? [...it.guide.madeSizes]
        : [...CORE_LETTER, ...CORE_WAIST].filter(s => sz.has(s));
      const gone = expected.filter(s => (sz.get(s) || 0) <= 0);
      if (!gone.length) continue;
      // A fully sold-out code belongs in section 1, not in "broken run".
      if (!expected.some(s => (sz.get(s) || 0) > 0)) continue;
      broken.push({ it, gone, guided, gaps: guided ? weightGaps(gone, it.guide) : [], push: it.total <= LEFTOVER_PUSH });
    }
    broken.sort((a, b) => b.gone.length - a.gone.length || b.it.total - a.it.total);

    // ---- 3 put on live next ----
    const lastLive = new Map();     // item key → ms of the latest time it was shown
    const seen = (k, t) => { if (t && t > (lastLive.get(k) || 0)) lastLive.set(k, t); };
    const lives = mergedLives();
    lives.forEach(s => s.codes.forEach(c => seen(keyOf(c.code), new Date(c.last || s.endedAt || s.startedAt).getTime())));
    const historyFrom = lives.length ? new Date(lives[0].startedAt).getTime() : null;
    const next = [];
    for (const it of list) {
      const p = it.product;
      if (!p || !it.total || liveOutOf(p)) continue;
      if (p.cycle_stage === "LIVE") seen(it.key, new Date(p.cycle_at).getTime());
      const t = lastLive.get(it.key) || 0;
      if (t && Date.now() - t < NOT_LIVE_DAYS * DAY) continue;
      next.push({ it, p, t, rounds: Number(p.cycle_round) || 0, fit: it.fit });
    }
    next.sort((a, b) => b.it.total - a.it.total);

    // ---- 4 pieces by customer weight; the old size bars remain in a fold-out ----
    const bars = g => g.map(s => [s, list.reduce((a, it) => a + (new Map(it.sizes).get(s) || 0), 0)]);
    const letter = bars(LETTER_BARS), waist = bars(WAIST_BARS);
    const weight = WEIGHT_BANDS.map(band => [band.label, list.reduce((sum, it) => {
      if (!it.product || !it.guide.weights.size) return sum;
      return sum + it.rows.reduce((n, row) => {
        const range = it.guide.weights.get(normalizeGuideSize(row.size));
        return n + (range && rangeFitsBand(range, band) ? Math.max(0, Number(row.qty) || 0) : 0);
      }, 0);
    }, 0)]);

    // ---- 5 best sellers ----
    let best = [], orderedTotal = null, restocks = 0;
    if (hist) {
      const byItem = new Map(), bySize = new Map();
      for (let k = hist.i0; k < drops.length; k++) {
        restocks += drops[k].restocks;
        for (const [ik, d] of drops[k].byItem) byItem.set(ik, (byItem.get(ik) || 0) + d);
        for (const [vk, d] of drops[k].byVar) { const [ik, , size] = vk.split("|"); const m = bySize.get(ik) || new Map(); m.set(size, (m.get(size) || 0) + d); bySize.set(ik, m); }
      }
      const visible = new Set(list.map(i => i.key));
      best = [...byItem.entries()].filter(([k]) => visible.has(k)).map(([k, n]) => ({ it: items.get(k), n, sizes: [...(bySize.get(k) || new Map()).entries()].sort((a, b) => sizeRank(a[0]) - sizeRank(b[0])) }))
        .sort((a, b) => b.n - a.n);
      orderedTotal = best.reduce((a, b) => a + b.n, 0);

      // ---- 6 runs out soon (per code + colour + size) ----
      var runout = [];
      if (hist.span >= 1) {
        const sold = new Map();
        for (let k = hist.i0; k < drops.length; k++) for (const [vk, d] of drops[k].byVar) sold.set(vk, (sold.get(vk) || 0) + d);
        for (const it of list) for (const r of it.rows) {
          if (r.qty <= 0) continue;
          const vk = `${it.key}|${r.colour}|${r.size}`, n = sold.get(vk) || 0;
          if (!n) continue;
          const perDay = n / hist.span, daysLeft = r.qty / perDay;
          if (daysLeft <= RUNOUT_DAYS) runout.push({ it, r, perDay, daysLeft });
        }
        runout.sort((a, b) => a.daysLeft - b.daysLeft || b.perDay - a.perDay);
      }
    }

    // ---- 7 does going live sell it? ----
    const effect = { sessions: [], shown: 0, shownN: 0, base: 0, baseN: 0 };
    for (const s of lives) {
      const t = new Date(s.startedAt).getTime();
      let i = -1; for (let k = 0; k < points.length; k++) if (points[k].at <= t) i = k;
      const j = points.findIndex(p => p.at >= t + LIVE_EFFECT_DAYS * DAY - 6 * 3600e3);
      if (i < 0 || j < 0 || j <= i) continue;
      const scale = LIVE_EFFECT_DAYS * DAY / (points[j].at - points[i].at);
      const shownKeys = new Set(s.codes.map(c => keyOf(c.code)));
      const near = new Set();
      lives.forEach(o => { const to = new Date(o.startedAt).getTime(); if (Math.abs(to - t) <= LIVE_EFFECT_DAYS * DAY) o.codes.forEach(c => near.add(keyOf(c.code))); });
      let sh = 0, shN = 0, bs = 0, bsN = 0;
      for (const k of shownKeys) { if (!(points[i].it.get(k) > 0)) continue; sh += orderedItem(k, i, j) * scale; shN++; }
      for (const [k, q] of points[i].it) { if (q <= 0 || near.has(k)) continue; bs += orderedItem(k, i, j) * scale; bsN++; }
      if (!shN) continue;
      effect.sessions.push({ s, shown: sh / shN, shownN: shN, base: bsN ? bs / bsN : 0 });
      effect.shown += sh; effect.shownN += shN; effect.base += bs; effect.baseN += bsN;
    }

    const unmatchedVrich = all.filter(i => !i.product);
    const notInVrich = S.products.filter(p => !matchedIds.has(p.id));

    return {
      snap, list, items, hist, pull, pulledDone, broken, next, historyFrom, weight, letter, waist, best, orderedTotal, restocks,
      runout: hist ? runout : null, effect, unmatchedVrich, notInVrich, points,
      codesInStock: list.filter(i => i.total > 0).length, pieces: list.reduce((a, i) => a + i.total, 0),
    };
  }
  function mergedLives() {
    const L = liveLast(), list = S.lives.slice();
    if (L && L.id && !list.some(x => x.id === L.id)) list.push({ id: L.id, startedAt: L.startedAt, endedAt: L.endedAt, codes: (L.codes || []).map(c => ({ ...c, code: norm(c.code) })) });
    return list.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  }

  function weightGaps(sizes, guide) {
    const ranges = sizes.map(size => ({ size, ...guide.weights.get(size) })).filter(r => Number.isFinite(r.min) && Number.isFinite(r.max))
      .sort((a, b) => a.min - b.min || a.max - b.max);
    const groups = [];
    for (const r of ranges) {
      const last = groups[groups.length - 1];
      if (last && r.min <= last.max) { last.max = Math.max(last.max, r.max); last.sizes.push(r.size); }
      else groups.push({ min: r.min, max: r.max, sizes: [r.size] });
    }
    return groups;
  }

  // ---------------- screen ----------------
  let raf = 0;
  function schedule() { S.dirty = true; if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (!container.closest("[hidden]")) render(); }); }

  function render() {
    S.dirty = false;
    const cats = (getCategories?.() || []);
    const err = sizesError();
    const snap = sizesSnapshot();
    const stale = snap?.at && Date.now() - new Date(snap.at).getTime() > 3 * 3600e3;
    $("#dash-head").innerHTML = `
      <div class="dash-top">
        <h2 class="dash-title">📊 Dashboard · ផ្ទាំងសង្ខេប</h2>
        <div class="dash-stamp ${stale ? "dash-stale" : ""}">📏 Stock from Vrich · ${snap ? `<b>${escapeHtml(stockAgo())}</b>` : "—"}${stale ? ` · old — click Copy Stock on the Vrich Sale page · ចាស់ហើយ` : ""}${err ? ` · <span class="size-err">${escapeHtml(err)}</span>` : ""}</div>
        <button type="button" class="btn btn-secondary dash-refresh" data-act="refresh">↻ Refresh · ធ្វើឲ្យថ្មី</button>
      </div>
      <div class="dash-pills">${[{ id: "", name: "All" }, ...cats].map(c => `<button type="button" class="pill-btn ${S.cat === c.id ? "active" : ""}" data-cat="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`).join("")}</div>`;
    const D = compute();
    if (!D) { $("#dash-body").innerHTML = `<p class="muted">${escapeHtml(err || "Loading stock from Vrich… · កំពុងផ្ទុក")}</p>`; return; }

    const tile = (n, en, km, cls = "", desk = false, target = "") => `<${target ? `a href="#${target}"` : "div"} class="dash-tile ${cls} ${desk ? "dash-desk" : ""}"><b>${n}</b><span>${en}</span><span class="km">${km}</span></${target ? "a" : "div"}>`;
    const tiles = `<div class="dash-tiles">
      ${tile(fmt(D.codesInStock), "codes in stock", "កូដមានស្តុក", "", true)}
      ${tile(fmt(D.pieces), "pieces left", "ចំនួនសល់")}
      ${tile(D.pull.length, "sold out but showing", "អស់ តែនៅបង្ហាញ", D.pull.length ? "dash-tile-red" : "", false, "dash-s1")}
      ${tile(D.broken.length, "broken size runs", "ទំហំដាច់", D.broken.length ? "dash-tile-amber" : "", false, "dash-s2")}
      ${tile(D.next.length, `not on live ${NOT_LIVE_DAYS}+ days`, `មិនបាន Live ${NOT_LIVE_DAYS}+ ថ្ងៃ`, "", false, "dash-s3")}
      ${tile(D.orderedTotal == null ? "—" : fmt(D.orderedTotal), "ordered last 7 days", "កុម្ម៉ង់ 7 ថ្ងៃ", "", true)}
    </div>`;

    $("#dash-body").innerHTML = `${tiles}
      <div class="dash-cols">
        <div class="dash-col">${secPull(D)}${secBroken(D)}${secNext(D)}</div>
        <div class="dash-col dash-desk${S.more ? " dash-show" : ""}">${secBars(D)}${secBest(D)}${secRunout(D)}${secEffect(D)}${secUnmatched(D)}</div>
      </div>
      <button type="button" class="btn btn-secondary dash-more-btn" data-act="more">${S.more ? "Hide charts · លាក់ក្រាហ្វ" : "Show charts · បង្ហាញក្រាហ្វ"}</button>`;
  }

  // shared bits
  const thumb = p => { const u = p?.images?.[0]?.url; return u ? `<img class="dash-thumb" src="${escapeHtml(u)}" alt="" loading="lazy" />` : `<span class="dash-thumb dash-thumb-none"></span>`; };
  const codeBtn = it => it.product
    ? `<button type="button" class="master-code dash-code" data-open="${escapeHtml(it.product.id)}">${escapeHtml(it.code)}</button>`
    : `<span class="master-code dash-code">${escapeHtml(it.code)}</span> <span class="dash-nomatch">not in VHM</span>`;
  const chips = (it, hot = []) => `<span class="dash-sizes">${it.sizes.map(([s, q]) => `<span class="size-chip ${q > 0 ? "size-in" : "size-out"}${hot.includes(s) ? " dash-core-out" : ""}" title="${q} left">${escapeHtml(s)}${q > 0 ? `<b>${q}</b>` : ""}</span>`).join("")}</span>`;
  function section(id, title, km, sub, rows, empty, { desk = false, cap = LIST_CAP } = {}) {
    const n = rows.length, open = S.open[id];
    return `<section class="dash-sec ${desk ? "" : ""}" id="dash-${id}">
      <h3>${title} <span class="km">· ${km}</span> ${n ? `<span class="dash-count">${n}</span>` : ""}</h3>
      ${sub ? `<p class="muted dash-sub">${sub}</p>` : ""}
      ${n ? `<div class="dash-list">${rows.slice(0, open ? n : cap).join("")}</div>` : `<p class="muted dash-empty">${empty}</p>`}
      ${n > cap ? `<button type="button" class="btn btn-secondary dash-all" data-all="${id}">${open ? "Show less · តិច" : `Show all ${n} · បង្ហាញទាំងអស់`}</button>` : ""}
    </section>`;
  }

  function secPull(D) {
    const action = SAMPLE_COUNTED ? "Pull it and pack it for the customer · ដកចេញ ហើយវេចខ្ចប់ឲ្យអតិថិជន" : "Pull it out of the live rotation · ដកចេញពី Live";
    const rows = D.pull.map(({ it, p, where }) => `<div class="dash-row">
        ${thumb(p)}
        <div class="dash-main">
          <div>${codeBtn(it)} <span class="dash-name">${escapeHtml(p.name || "")}</span></div>
          <div class="dash-meta"><span class="dash-where dash-where-${where.kind}">${escapeHtml(where.label)}</span>${where.since ? ` <span class="muted">${ago(where.since)}</span>` : ""} <span class="muted">· 🎥 ×${Number(p.cycle_round) || 0}</span> <span class="dash-zero">0 left</span></div>
        </div>
        <button type="button" class="btn btn-primary dash-btn" data-pull="${escapeHtml(p.id)}">✓ Mark pulled<span class="km">ដកចេញហើយ</span></button>
      </div>`);
    const done = D.pulledDone.length ? `<details class="dash-done"><summary>✓ Pulled on this device (${D.pulledDone.length}) · បានដកចេញ</summary>${D.pulledDone.map(({ it, p }) => `<div class="dash-row dash-row-done">${codeBtn(it)} <span class="muted">${escapeHtml(p.name || "")} · ${ago(S.pulled[p.id])} ago</span><button type="button" class="btn btn-secondary dash-btn-sm" data-unpull="${escapeHtml(p.id)}">Undo · ដកវិញ</button></div>`).join("")}</details>` : "";
    return section("s1", "Pull out — sold out but still showing", "ដកចេញ — លក់អស់ តែនៅបង្ហាញ", `0 left in Vrich, but the piece is still in a sample container or out from the last live. ${action}.`, rows, "Nothing to pull — every sold-out code is already off display ✓").replace(/<\/section>$/, done + "</section>");
  }

  function secBroken(D) {
    const rows = D.broken.map(({ it, gone, guided, gaps, push }) => `<div class="dash-row">
        ${thumb(it.product)}
        <div class="dash-main">
          <div>${codeBtn(it)} <span class="dash-name">${escapeHtml(it.product?.name || "")}</span></div>
          <div class="dash-meta">${chips(it, gone)}</div>
          ${guided && gaps.length ? `<div class="dash-weight-gap">Nothing left for ${gaps.map(g => `<b>${g.min}–${g.max} kg</b> <span class="muted">(${g.sizes.map(escapeHtml).join(", ")})</span>`).join("; ")} customers · អតិថិជនទម្ងន់នេះអស់ទំហំ</div>` : ""}
          <div class="dash-hint">${push
            ? `Push the ${it.total} leftover${it.total === 1 ? "" : "s"} on live · លក់ដែលសល់នៅ Live <span class="muted">— or restock ${gone.join(", ")}</span>`
            : `Restock ${gone.join(", ")} · បន្ថែមស្តុក <span class="muted">— ${it.total} pieces left in other sizes</span>`}</div>
        </div>
      </div>`);
    return section("s2", "Broken size runs", "ទំហំសំខាន់អស់", `Uses each product's weight guide and full made-size list; a size missing from Vrich counts as 0. Products without a readable guide fall back to core sizes (${CORE_LETTER.join(" / ")} or waist ${CORE_WAIST[0]}–${CORE_WAIST[CORE_WAIST.length - 1]}).`, rows, "No broken size runs ✓");
  }

  function secNext(D) {
    const rows = D.next.map(({ it, p, t, rounds, fit }) => `<div class="dash-row">
        ${thumb(p)}
        <div class="dash-main">
          <div>${codeBtn(it)} <span class="dash-name">${escapeHtml(p.name || "")}</span></div>
          <div class="dash-meta"><b>${it.total}</b> <span class="muted">pieces</span> · ${t ? `last live <b>${Math.floor((Date.now() - t) / DAY)} days ago</b>` : rounds ? `<span class="muted">live ×${rounds}, date not recorded</span>` : `<b>never live</b>`}${p[LOCATION_FIELDS.sample] ? ` · 👕 ${escapeHtml(p[LOCATION_FIELDS.sample])}` : ""}</div>
          <div class="dash-meta">${chips(it)}${fit ? ` <span class="dash-fit">fits ${fit.min}–${fit.max} kg · សម ${fit.min}–${fit.max} គីឡូ</span>` : ""}</div>
        </div>
      </div>`);
    const since = D.historyFrom ? `Live history since ${shortDate(D.historyFrom)} (VHM Live Log ⏹ End live).` : "No live history yet — it starts with the next ⏹ End live in VHM Live Log.";
    return section("s3", "Put on live next", "យកទៅ Live បន្ទាប់", `In stock, not shown in a live for ${NOT_LIVE_DAYS}+ days (or never), most pieces first. ${since}`, rows, "Every code in stock was shown recently ✓");
  }

  function secBars(D) {
    const group = (title, data, weightLabels = false) => {
      const max = Math.max(1, ...data.map(d => d[1]));
      if (!data.some(d => d[1])) return "";
      return `<div class="dash-bars-group"><div class="dash-bars-title">${title}</div>${data.map(([s, n]) => {
        const low = n < max * 0.3;
        return `<div class="dash-bar-row" title="${escapeHtml(s)}: ${n} pieces left${low ? " — low" : ""}"><span class="dash-bar-lab${weightLabels ? " dash-bar-lab-weight" : ""}">${escapeHtml(s)}</span><span class="dash-bar-track"><span class="dash-bar ${low ? "dash-bar-low" : ""}" style="width:${Math.max(n ? 1.5 : 0, n / max * 100)}%"></span></span><span class="dash-bar-val">${fmt(n)}${low ? ` <span class="dash-low">low</span>` : ""}</span></div>`;
      }).join("")}</div>`;
    };
    const weightBody = group("Customer weight · គីឡូ", D.weight, true);
    const sizeBody = group("Shirts & letter sizes · អាវ", D.letter) + group("Pants · waist · ខោ", D.waist);
    return `<section class="dash-sec" id="dash-s4"><h3>Pieces that fit each weight band <span class="km">· ចំនួនសល់តាមគីឡូ</span></h3>
      ${weightBody || `<p class="muted dash-empty">No readable weight guides for stock in this category.</p>`}
      <p class="muted dash-sub">Calculated from each product's own guide. A piece spanning two bands appears in both.</p>
      <details class="dash-done dash-size-fold"><summary>Pieces left by size · ចំនួនសល់តាមទំហំ</summary>
        ${sizeBody || `<p class="muted dash-empty">No sized stock in this category.</p>`}
        <p class="muted dash-sub">Orange = under 30% of the biggest size in the group.</p>
      </details></section>`;
  }

  function needHistory(D, what) {
    const first = S.days[0]?.day;
    return S.histLoading ? `<p class="muted dash-empty">Loading history… · កំពុងផ្ទុក</p>`
      : `<p class="muted dash-empty">${what} needs the daily stock history. ${first ? `It started ${escapeHtml(first)} — fills in after a day or two.` : `It starts with the first Copy Stock click after staff install the new bookmarklet.`}${S.histErr ? ` <span class="size-err">${escapeHtml(S.histErr)}</span>` : ""}</p>`;
  }
  const spanTxt = D => D.hist ? `${D.hist.span < 6.5 ? `${D.hist.span.toFixed(1)} days of data so far` : "last 7 days"} (since ${shortDate(D.hist.from)})` : "";

  function secBest(D) {
    if (!D.hist) return `<section class="dash-sec" id="dash-s5"><h3>Best sellers · 7 days <span class="km">· លក់ដាច់ជាងគេ</span></h3>${needHistory(D, "This")}</section>`;
    const max = Math.max(1, ...D.best.map(b => b.n));
    const rows = D.best.map(({ it, n, sizes }) => `<div class="dash-row dash-row-tight">
        <div class="dash-main">
          <div>${codeBtn(it)} <span class="dash-name">${escapeHtml(it.product?.name || "")}</span></div>
          <div class="dash-meta muted">${sizes.map(([s, q]) => `${escapeHtml(s)} ${q}`).join(" · ")}</div>
        </div>
        <span class="dash-bar-track dash-bar-inline" title="${n} pieces ordered"><span class="dash-bar" style="width:${n / max * 100}%"></span></span>
        <b class="dash-num">${n}</b>
      </div>`);
    return section("s5", "Best sellers · 7 days", "លក់ដាច់ជាងគេ", `Pieces ordered = drop in Vrich "left" (counts unpaid orders too) — ${spanTxt(D)}.${D.restocks ? ` ${D.restocks} restocked lines ignored.` : ""}`, rows, "No orders seen in this window yet.", { cap: 10 });
  }

  function secRunout(D) {
    if (!D.hist || D.runout == null || D.hist.span < 1) return `<section class="dash-sec" id="dash-s6"><h3>Runs out soon <span class="km">· ជិតអស់</span></h3>${D.hist && D.hist.span < 1 ? `<p class="muted dash-empty">Needs at least 1 day of history — ${spanTxt(D)}.</p>` : needHistory(D, "This")}</section>`;
    const rows = D.runout.map(({ it, r, perDay, daysLeft }) => `<div class="dash-row dash-row-tight">
        <div class="dash-main"><div>${codeBtn(it)} <b>${escapeHtml(r.size)}</b> ${escapeHtml(r.colour)}</div></div>
        <span class="dash-meta"><b>${r.qty}</b> left · <span class="${daysLeft <= 2 ? "dash-zero" : ""}">~${daysLeft < 1 ? "<1" : Math.round(daysLeft)} day${Math.round(daysLeft) === 1 ? "" : "s"}</span> <span class="muted">(${perDay.toFixed(1)}/day)</span></span>
      </div>`);
    return section("s6", "Runs out soon", "ជិតអស់", `Gone within ${RUNOUT_DAYS} days at this week's speed — ${spanTxt(D)}.`, rows, "Nothing runs out within a week at this speed ✓", { cap: 15 });
  }

  function secEffect(D) {
    const E = D.effect;
    const head = `<h3>Does going live sell it? <span class="km">· Live ហើយលក់ដាច់ទេ?</span></h3>`;
    if (!E.sessions.length) {
      const why = !mergedLives().length ? "No live recorded yet (VHM Live Log ⏹ End live)." : `Needs a live with ${LIVE_EFFECT_DAYS} days of stock history after it.`;
      return `<section class="dash-sec" id="dash-s7">${head}<p class="muted dash-empty">${why} ${S.days[0] ? `Stock history since ${escapeHtml(S.days[0].day)}.` : ""}</p></section>`;
    }
    const shown = E.shown / E.shownN, base = E.baseN ? E.base / E.baseN : 0, max = Math.max(shown, base, 0.01);
    const ratio = base > 0 ? shown / base : null;
    return `<section class="dash-sec" id="dash-s7">${head}
      <p class="muted dash-sub">Average pieces ordered per code in the ${LIVE_EFFECT_DAYS} days after a live, codes shown vs. codes in stock not shown (${E.sessions.length} live${E.sessions.length === 1 ? "" : "s"}).</p>
      <div class="dash-effect">
        <div class="dash-bar-row"><span class="dash-bar-lab dash-bar-lab-w">Shown · បានបង្ហាញ</span><span class="dash-bar-track"><span class="dash-bar" style="width:${shown / max * 100}%"></span></span><span class="dash-bar-val"><b>${shown.toFixed(1)}</b> <span class="muted">(${E.shownN})</span></span></div>
        <div class="dash-bar-row"><span class="dash-bar-lab dash-bar-lab-w">Not shown · មិនបានបង្ហាញ</span><span class="dash-bar-track"><span class="dash-bar dash-bar-muted" style="width:${base / max * 100}%"></span></span><span class="dash-bar-val"><b>${base.toFixed(1)}</b> <span class="muted">(${E.baseN})</span></span></div>
      </div>
      ${ratio ? `<p class="dash-verdict">Shown codes sold <b>×${ratio.toFixed(1)}</b> as much${ratio < 1.2 ? " — little difference" : ""}.</p>` : ""}
      <details class="dash-done"><summary>Per live · តាម Live</summary><table class="variant-inline-table"><thead><tr><th>Live</th><th>Codes</th><th>Shown</th><th>Not shown</th></tr></thead><tbody>
        ${E.sessions.slice().reverse().map(x => `<tr><td>${escapeHtml(new Date(x.s.startedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</td><td>${x.shownN}</td><td>${x.shown.toFixed(1)}</td><td>${x.base.toFixed(1)}</td></tr>`).join("")}
      </tbody></table></details>
    </section>`;
  }

  function secUnmatched(D) {
    if (!D.unmatchedVrich.length && !D.notInVrich.length) return "";
    const list = arr => arr.slice(0, 300).map(x => `<span class="dash-um">${escapeHtml(x)}</span>`).join("") + (arr.length > 300 ? ` <span class="muted">+${arr.length - 300}</span>` : "");
    return `<section class="dash-sec" id="dash-s8"><h3>No Vrich match <span class="km">· មិនត្រូវគ្នា</span></h3>
      <p class="muted dash-sub">Not counted anywhere above (never treated as 0 stock).</p>
      ${D.unmatchedVrich.length ? `<details class="dash-done"><summary>In Vrich, not in VHM Inventory (${D.unmatchedVrich.length}) · មិនមានក្នុង VHM</summary><div class="dash-um-list">${list(D.unmatchedVrich.map(i => `${i.code} · ${i.total}`))}</div></details>` : ""}
      ${D.notInVrich.length ? `<details class="dash-done"><summary>In VHM Inventory, not on today's Vrich sale (${D.notInVrich.length}) · មិនមានក្នុង Vrich</summary><div class="dash-um-list">${list(D.notInVrich.map(p => p.master_code))}</div></details>` : ""}
    </section>`;
  }

  // ---------------- clicks ----------------
  container.addEventListener("click", e => {
    const b = e.target.closest("[data-act],[data-cat],[data-pull],[data-unpull],[data-all],[data-open]");
    if (!b) return;
    if (b.dataset.cat !== undefined) { S.cat = b.dataset.cat; lsSet("cat", S.cat); render(); return; }
    if (b.dataset.act === "refresh") return refresh();
    if (b.dataset.act === "more") { S.more = !S.more; render(); return; }
    if (b.dataset.all) { S.open[b.dataset.all] = !S.open[b.dataset.all]; render(); return; }
    if (b.dataset.pull) {
      const id = b.dataset.pull; S.pulled[id] = new Date().toISOString(); lsSet("pulled", S.pulled); render();
      const p = S.products.find(x => x.id === id);
      toast(`${p?.master_code || ""} pulled · ដកចេញហើយ`);
      return;
    }
    if (b.dataset.unpull) { delete S.pulled[b.dataset.unpull]; lsSet("pulled", S.pulled); render(); return; }
    if (b.dataset.open) { const p = S.products.find(x => x.id === b.dataset.open); if (p && openProduct) openProduct(p); }
  });

  // a tick is forgotten once the code has stock again (restocked → it can show again)
  function tidyPulled() {
    const snap = sizesSnapshot(); if (!snap) return;
    let changed = false;
    for (const id of Object.keys(S.pulled)) {
      const p = S.products.find(x => x.id === id);
      if (!p) continue;
      const rows = snap.byCode.get(norm(p.master_code)) || snap.byBase.get(norm(p.master_code));
      if (rows && rows.some(r => r.qty > 0)) { delete S.pulled[id]; changed = true; }
    }
    if (changed) lsSet("pulled", S.pulled);
  }

  useProducts(getProducts());
  const unsub = onProducts(list => { useProducts(list); tidyPulled(); });
  const stopSizes = onSizes(() => { tidyPulled(); schedule(); });
  const stopLive = onLive(schedule);
  checkLive();
  loadHistory();
  const ticker = setInterval(() => { if (!container.closest("[hidden]")) schedule(); }, 60000);
  tidyPulled();

  return {
    show() { if (S.dirty) render(); },
    stop() { unsub(); stopSizes(); stopLive(); clearInterval(ticker); },
  };
}
