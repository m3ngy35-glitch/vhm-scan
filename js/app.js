// ============================================================================
// app.js — main entry point. Wires together search, product grid,
// inline variant editing, and the modals (product form, category/tag manager).
// ============================================================================

import { subscribeProducts, listCategories, listTags, archiveProduct, restoreProduct, patchVariant, patchProduct, exportAllData } from "./db.js";
import { buildSearchIndex, searchProducts, highlight } from "./search.js";
import { badge, toast, openGallery, escapeHtml, confirmDialog } from "./ui-components.js";
import { SIZES, LOCATION_FIELDS, STORAGE_LOCATIONS, SAMPLE_LOCATIONS } from "./constants.js";
import { openProductForm } from "./product-form.js";
import { openProductDetail } from "./product-detail.js";
import { openCategoryTagManager } from "./category-tag-manager.js";
import { watchAuth, login, logout } from "./auth.js";
import { initCycleTab, stageChip } from "./cycle-tab.js";
import { initDashboardTab } from "./dashboard-tab.js";
import { startSizes, onSizes, sizesLoaded, isSizeTerm, stockRows, sizeTotals, hasSizeInStock, stockAgo, sizesError, checkSizes } from "./stock-sizes.js";

const state = {
  products: [],
  allProducts: [], // includes soft-deleted, for the Recently Deleted view
  categories: [],
  tags: [],
  categoriesById: {},
  tagsById: {},
  searchIndex: [],
  query: "",
  filters: { categoryId: "", tagId: "", size: "" },
};

const els = {
  grid: document.getElementById("product-grid"),
  searchInput: document.getElementById("search-input"),
  searchClear: document.getElementById("search-clear"),
  categoryFilter: document.getElementById("filter-category"),
  tagFilter: document.getElementById("filter-tag"),
  sizeFilter: document.getElementById("filter-size"),
  resultCount: document.getElementById("result-count"),
  newProductBtn: document.getElementById("btn-new-product"),
  manageBtn: document.getElementById("btn-manage-cattags"),
  categoryPills: document.getElementById("category-pills"),
  filtersBtn: document.getElementById("btn-filters"),
  filtersPanel: document.getElementById("filters-panel"),
  filtersBackdrop: document.getElementById("filters-backdrop"),
  filtersCloseBtn: document.getElementById("btn-filters-close"),
  filtersApplyBtn: document.getElementById("btn-filters-apply"),
};

async function loadMeta() {
  const [allCats, allTags] = await Promise.all([listCategories(), listTags()]);
  // deleted (soft) tags/categories are hidden everywhere until restored
  const categories = allCats.filter(c => !c.deleted), tags = allTags.filter(t => !t.deleted);
  state.categories = categories;
  state.tags = tags;
  state.categoriesById = Object.fromEntries(categories.map(c => [c.id, c]));
  state.tagsById = Object.fromEntries(tags.map(t => [t.id, t]));

  els.categoryFilter.innerHTML = `<option value="">All categories</option>` +
    categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  els.tagFilter.innerHTML = `<option value="">All tags</option>` +
    tags.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  els.sizeFilter.innerHTML = `<option value="">All sizes</option>` +
    SIZES.map(s => `<option value="${s}">${s}</option>`).join("");

  // Mobile-only quick-filter strip — the same categoryId state the
  // dropdown in the filters drawer controls, just as one-tap pills for
  // the filter people reach for most often, instead of opening the
  // drawer for it every time.
  if (els.categoryPills) {
    els.categoryPills.innerHTML = `<button type="button" class="pill-btn active" data-id="">All</button>` +
      categories.map(c => `<button type="button" class="pill-btn" data-id="${c.id}">${escapeHtml(c.name)}</button>`).join("");
  }
}

function rebuildIndex() {
  state.searchIndex = buildSearchIndex(state.products, state.categoriesById, state.tagsById);
}

// With Vrich stock sizes loaded, a search word that is a size (S, M, XL, 2XL, 32 …)
// means "has that size IN STOCK" instead of a text match: "polo m", "32", "m l".
// Several sizes = any of them. The Size filter works the same way.
function splitSizeTerms(raw) {
  if (!sizesLoaded()) return { text: raw, sizes: [] };
  const trailing = /\s$/.test(raw || "");
  const words = (raw || "").trim().split(/\s+/).filter(Boolean);
  const sizes = words.filter(isSizeTerm).map(w => w.toUpperCase());
  const text = words.filter(w => !isSizeTerm(w)).join(" ");
  return { text: text + (trailing && text ? " " : ""), sizes };
}

function renderGrid() {
  // someone is typing a location on a card: don't wipe the box — redraw when they leave it
  if (isTypingLoc()) { state.gridDirty = true; return; }
  state.gridDirty = false;
  refreshLocLists();
  const { text, sizes } = splitSizeTerms(state.query);
  state.textQuery = text;
  state.sizeTerms = sizes;
  const filterSize = state.filters.size || null;
  let results = searchProducts(state.searchIndex, text, {
    categoryId: state.filters.categoryId || null,
    tagId: state.filters.tagId || null,
    size: sizesLoaded() ? null : filterSize,
  });
  if (sizes.length) results = results.filter(p => hasSizeInStock(p, sizes));
  if (filterSize && sizesLoaded()) results = results.filter(p => hasSizeInStock(p, [filterSize]));
  const inStockTxt = [...sizes, ...(filterSize && sizesLoaded() ? [filterSize] : [])];
  els.resultCount.textContent = `${results.length} product${results.length === 1 ? "" : "s"}` + (inStockTxt.length ? ` with ${inStockTxt.join(" / ")} in stock` : "");
  renderSizesStamp();

  if (!results.length) {
    els.grid.innerHTML = `<p class="muted">No products match your search.</p>`;
    return;
  }

  els.grid.innerHTML = results.map(p => renderProductCard(p)).join("");
  wireCardEvents(results);
  wireLocInputs();
}

// Short descriptions just print in full — nothing to compact. A long one
// only takes up a couple of lines by default (as a <summary>, same
// collapsed-by-default pattern as the variant quick-edit table below it),
// and clicking it expands to the full text right there on the card.
// "Short" has to account for LINE count, not just character count — a
// 5-line weight guide (one size per line) can be well under 100
// characters total but still too many lines to show uncollapsed without
// getting clipped, so either going over length OR going over 3 lines
// triggers the same collapsible treatment.
const DESC_COMPACT_LEN = 100;
const DESC_COMPACT_LINES = 3;
function renderDescription(description) {
  if (!description) return "";
  const lineCount = description.split("\n").length;
  if (description.length <= DESC_COMPACT_LEN && lineCount <= DESC_COMPACT_LINES) {
    return `<p class="card-description-full muted">${escapeHtml(description)}</p>`;
  }
  const preview = description.slice(0, DESC_COMPACT_LEN).trim();
  return `
    <details class="desc-inline">
      <summary class="card-description muted">
        <span class="desc-preview">${escapeHtml(preview)}&hellip;</span>
        <span class="desc-toggle-hint desc-hint-more">read more</span>
        <span class="desc-toggle-hint desc-hint-less">show less</span>
      </summary>
      <p class="card-description-full muted">${escapeHtml(description)}</p>
    </details>
  `;
}

function renderProductCard(p) {
  const category = state.categoriesById[p.category_id];
  const tags = (p.tag_ids || []).map(id => state.tagsById[id]).filter(Boolean);
  const cover = p.images?.[0]?.url || "";
  const totalStock = (p.variants || []).reduce((sum, v) => sum + (Number(v.stock_quantity) || 0), 0);
  const lowStock = totalStock === 0;
  const prices = (p.variants || []).map(v => Number(v.price) || 0).filter(n => n > 0);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const priceLabel = minPrice === null ? null : minPrice === maxPrice ? `$${minPrice.toFixed(2)}` : `$${minPrice.toFixed(2)}–${maxPrice.toFixed(2)}`;

  return `
    <div class="product-card" data-id="${p.id}">
      <div class="card-image" data-id="${p.id}">
        ${cover ? `<img src="${cover}" alt="${escapeHtml(p.name)}" loading="lazy" decoding="async" />` : `<div class="no-image">No image</div>`}
        ${priceLabel ? `<span class="price-tag">${priceLabel}</span>` : ""}
        ${p.images?.length > 1 ? `<span class="image-count">${p.images.length} photos</span>` : ""}
      </div>
      <div class="card-locations">
        <!-- green chip = sample, yellow chip = stock location (the colours staff know) -->
        ${locInput(p, "sample")}
        ${locInput(p, "stock")}
        ${stageChip(p.cycle_stage, p.cycle_at)}
      </div>
      ${renderSizeChips(p)}
      <div class="card-body">
        <div class="card-top-row">
          <span class="master-code master-code-clickable" data-id="${p.id}" title="Tap to view details">${highlight(p.master_code, state.textQuery ?? state.query)}</span>
          ${category ? badge(category.name, category.color_code) : ""}
        </div>
        <h3 class="card-title">${highlight(p.name, state.textQuery ?? state.query)}</h3>
        <div class="card-tags">${tags.map(t => badge(t.name, t.color_code)).join(" ")}</div>
        ${renderDescription(p.description)}
        ${(() => {                     // Vrich stock wins when it is loaded; the typed variant stock is only a fallback
          const vr = sizesLoaded() ? stockRows(p) : null;
          if (vr) { const t = vr.reduce((a, r) => a + r.qty, 0); return `<div class="card-stock ${t ? "" : "stock-zero"}">In stock (Vrich): ${t}</div>`; }
          if (sizesLoaded()) return "";
          return `<div class="card-stock ${lowStock ? "stock-zero" : ""}">Total stock: ${totalStock}</div>`;
        })()}
        <details class="variant-inline">
          <summary>${(p.variants || []).length} variant${(p.variants || []).length === 1 ? "" : "s"} — quick edit</summary>
          <table class="variant-inline-table">
            <thead><tr><th>Size</th><th>Color</th><th>POS</th><th>Stock</th><th>Price</th></tr></thead>
            <tbody>
              ${(p.variants || []).map((v, i) => `
                <tr>
                  <td data-label="Size">${v.size}</td>
                  <td data-label="Color"><span class="swatch" style="background:${v.color_hex}"></span>${escapeHtml(v.color_name)}</td>
                  <td data-label="POS"><input class="inline-pos" data-pid="${p.id}" data-idx="${i}" value="${escapeHtml(v.pos_code)}" /></td>
                  <td data-label="Stock"><input class="inline-stock" type="number" min="0" data-pid="${p.id}" data-idx="${i}" value="${v.stock_quantity}" /></td>
                  <td data-label="Price"><input class="inline-price" type="number" min="0" step="0.01" data-pid="${p.id}" data-idx="${i}" value="${v.price ?? 0}" /></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </details>
        <div class="card-actions">
          <button class="btn btn-secondary btn-edit" data-id="${p.id}">Edit</button>
          <button class="btn btn-danger btn-delete" data-id="${p.id}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

// ---------- Locations: edit right on the card ----------
// Tap the chip and type — it saves by itself (1 s after you stop typing, on Enter,
// or when you leave the box). Enter also jumps to the same box on the next card,
// so a whole shelf can be typed in one go. Esc puts the saved value back.
// Every change shows an Undo. Clearing a location only saves on Enter / leaving.
function locInput(p, which) {
  const field = LOCATION_FIELDS[which], v = p[field] || "";
  const q = (state.textQuery ?? state.query ?? "").trim().toLowerCase();
  const hit = q && v && v.toLowerCase().includes(q);
  return `<label class="loc-chip ${which === "sample" ? "loc-chip-storage" : "loc-chip-sample"} loc-edit${hit ? " loc-hit" : ""}" title="${which === "sample" ? "Sample location (display piece)" : "Storage location (actual stock)"} — type to change">${which === "sample" ? "👕" : "📦"}<input class="loc-input" data-pid="${p.id}" data-which="${which}" data-saved="${escapeHtml(v)}" value="${escapeHtml(v)}" placeholder="—" size="${Math.max(2, v.length + 1)}" list="dl-loc-${which}" autocomplete="off" spellcheck="false" enterkeyhint="next" /></label>`;
}
const LOC_DEBOUNCE_MS = 1000;
function cleanLocValue(which, raw) {
  const t = (raw || "").replace(/\s+/g, " ").trim();
  return which === "stock" ? t.toUpperCase() : t;          // stock bins are saved in capitals: b23 → B23
}
async function saveLoc(input, { force } = {}) {
  clearTimeout(input._t);
  const which = input.dataset.which, field = LOCATION_FIELDS[which], pid = input.dataset.pid;
  const val = cleanLocValue(which, input.value), old = input.dataset.saved || "";
  if (val === old) { input.value = old; return; }
  if (!val && !force) return;                               // a cleared box only saves on Enter / leaving
  input.dataset.saved = val;                                 // so a second trigger doesn't save twice
  input.value = val;
  const chip = input.closest(".loc-edit"); chip?.classList.add("loc-saving");
  try {
    await patchProduct(pid, { [field]: val });
    chip?.classList.remove("loc-saving"); chip?.classList.add("loc-saved"); setTimeout(() => chip?.classList.remove("loc-saved"), 900);
    const p = state.allProducts.find(x => x.id === pid);
    undoToast(`${p?.master_code || ""} ${which === "sample" ? "👕" : "📦"} ${old || "—"} → ${val || "—"}`, async () => {
      await patchProduct(pid, { [field]: old });
      toast(`${p?.master_code || ""} back to ${old || "—"}`);
    });
  } catch (e) {
    input.dataset.saved = old; chip?.classList.remove("loc-saving");
    toast("Location not saved: " + e.message, "error");
  }
}
function wireLocInputs() {
  els.grid.querySelectorAll(".loc-input").forEach(input => {
    input.addEventListener("input", () => {
      input.size = Math.max(2, input.value.length + 1);
      clearTimeout(input._t);
      input._t = setTimeout(() => saveLoc(input), LOC_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Escape") { clearTimeout(input._t); input.value = input.dataset.saved || ""; input.blur(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      saveLoc(input, { force: true });
      // jump to the same location box on the next (or, with Shift, previous) card
      const all = [...els.grid.querySelectorAll(`.loc-input[data-which="${input.dataset.which}"]`)];
      const next = all[all.indexOf(input) + (e.shiftKey ? -1 : 1)];
      if (next) { next.focus(); next.select(); } else input.blur();
    });
    input.addEventListener("focus", () => input.select());
    input.addEventListener("blur", () => {
      saveLoc(input, { force: true });
      // the list was refreshed while typing: redraw once nobody is typing in a location box
      setTimeout(() => { if (state.gridDirty && !isTypingLoc()) renderGrid(); }, 0);
    });
  });
}
const isTypingLoc = () => document.activeElement?.classList?.contains("loc-input") && els.grid.contains(document.activeElement);
// autocomplete lists: every location already used + the usual bins / spots
function refreshLocLists() {
  const fill = (id, values) => {
    let dl = document.getElementById(id);
    if (!dl) { dl = document.createElement("datalist"); dl.id = id; document.body.appendChild(dl); }
    const html = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(v => `<option value="${escapeHtml(v)}"></option>`).join("");
    if (dl._html !== html) { dl.innerHTML = html; dl._html = html; }
  };
  fill("dl-loc-stock", [...STORAGE_LOCATIONS, ...state.products.map(p => p[LOCATION_FIELDS.stock])]);
  fill("dl-loc-sample", [...SAMPLE_LOCATIONS, ...state.products.map(p => p[LOCATION_FIELDS.sample])]);
}
let undoTimer = null;
function undoToast(message, onUndo) {
  let el = document.getElementById("undo-toast");
  if (!el) { el = document.createElement("div"); el.id = "undo-toast"; el.className = "undo-toast"; document.body.appendChild(el); }
  el.innerHTML = `<span></span><button type="button">Undo · ដកវិញ</button>`;
  el.querySelector("span").textContent = message;
  el.querySelector("button").onclick = async () => { el.classList.remove("show"); try { await onUndo(); } catch (e) { toast("Undo failed: " + e.message, "error"); } };
  el.classList.add("show");
  clearTimeout(undoTimer); undoTimer = setTimeout(() => el.classList.remove("show"), 6000);
}

// Sizes in stock (Vrich Sale page remain + stock not in the sale yet).
function renderSizeChips(p) {
  if (!sizesLoaded()) return "";
  const rows = stockRows(p);
  if (!rows) return `<div class="size-row"><span class="size-none">No Vrich stock · អស់ស្តុក</span></div>`;
  const want = new Set([...(state.sizeTerms || []), ...(state.filters.size ? [state.filters.size.toUpperCase()] : [])]);
  const totals = sizeTotals(rows);
  const chips = totals.map(([size, q]) => `<span class="size-chip ${q > 0 ? "size-in" : "size-out"}${want.has(size) ? " size-want" : ""}" title="${q} left">${escapeHtml(size)}${q > 0 ? `<b>${q}</b>` : ""}</span>`).join("");
  const colours = [...new Set(rows.map(r => r.colour))];
  const byColour = colours.length > 1 || (colours[0] && totals.length > 1)
    ? `<details class="size-colours"><summary>by colour · តាមពណ៌</summary>${colours.map(c => {
        const rs = sizeTotals(rows.filter(r => r.colour === c));
        return `<div><span class="size-colour">${escapeHtml(c || "—")}</span> ${rs.map(([s, q]) => `<span class="${q > 0 ? "size-in-txt" : "size-out-txt"}">${escapeHtml(s)}${q > 0 ? " " + q : ""}</span>`).join(" · ")}</div>`;
      }).join("")}</details>` : "";
  return `<div class="size-row">${chips}</div>${byColour}`;
}

function renderSizesStamp() {
  const el = document.getElementById("sizes-stamp");
  if (!el) return;
  const err = sizesError();
  el.innerHTML = sizesLoaded()
    ? `📏 Stock sizes ${escapeHtml(stockAgo())}${err ? ` · <span class="size-err">${escapeHtml(err)}</span>` : ""} · <a href="#" id="sizes-refresh">check</a>`
    : err ? `📏 <span class="size-err">${escapeHtml(err)}</span>` : "";
  const a = el.querySelector("#sizes-refresh");
  if (a) a.onclick = e => { e.preventDefault(); checkSizes().then(() => { renderGrid(); toast(sizesError() || "Stock sizes are up to date"); }); };
}

function wireCardEvents(results) {
  const byId = Object.fromEntries(results.map(p => [p.id, p]));

  document.querySelectorAll(".card-image").forEach(el => {
    el.onclick = () => {
      const p = byId[el.dataset.id];
      if (p.images?.length) openGallery(p.images, 0);
    };
  });

  // Tapping the code opens a read-only "quick view" popup — photo, tags,
  // price, category and the full description together in one window,
  // without leaving the grid or opening the Edit form. Works the same on
  // mobile and desktop since it's the same modal-overlay used everywhere
  // else in the app.
  document.querySelectorAll(".master-code-clickable").forEach(el => {
    el.onclick = () => {
      const p = byId[el.dataset.id];
      openProductDetail(p, {
        category: state.categoriesById[p.category_id],
        tags: (p.tag_ids || []).map(id => state.tagsById[id]).filter(Boolean),
      });
    };
  });

  document.querySelectorAll(".btn-edit").forEach(btn => {
    btn.onclick = () => {
      openProductForm({
        product: byId[btn.dataset.id],
        categories: state.categories,
        tags: state.tags,
        onSaved: () => {}, // live subscription re-renders automatically
      });
    };
  });

  document.querySelectorAll(".btn-delete").forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmDialog("Remove this product? You can restore it later from \"Recently Deleted\".");
      if (!ok) return;
      btn.disabled = true;
      try {
        await archiveProduct(btn.dataset.id);
        toast("Product removed — recoverable from Recently Deleted");
      } catch (e) {
        toast("Delete failed: " + e.message, "error");
        btn.disabled = false;
      }
    };
  });

  // Inline quick-edit: POS code, stock, price — debounced-ish on blur/enter.
  // Storage/sample location live on the product itself now (set from the
  // Edit Product form), not per variant, so they're not part of this table.
  document.querySelectorAll(".inline-pos, .inline-stock, .inline-price").forEach(input => {
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
    // the value as shown when the box was drawn — leaving the box without changing it saves nothing
    // (before, every click or Tab through these boxes was a save: 1 read + 1 write, plus 1 read on every other device)
    input.dataset.saved = input.value;
    input.addEventListener("blur", async () => {
      const pid = input.dataset.pid, idx = +input.dataset.idx;
      let patch, now;
      if (input.classList.contains("inline-stock")) { now = String(Number(input.value) || 0); patch = { stock_quantity: Number(now) }; }
      else if (input.classList.contains("inline-price")) { now = String(Number(input.value) || 0); patch = { price: Number(now) }; }
      else { now = input.value.trim(); patch = { pos_code: now }; }
      const was = input.classList.contains("inline-pos") ? (input.dataset.saved || "").trim() : String(Number(input.dataset.saved) || 0);
      if (now === was) return;
      try {
        await patchVariant(pid, idx, patch);
        input.dataset.saved = now;
        toast("Variant updated");
      } catch (e) {
        toast("Update failed: " + e.message, "error");
      }
    });
  });
}

function wireToolbar() {
  els.searchInput.addEventListener("input", () => {
    state.query = els.searchInput.value;
    els.searchClear.hidden = !els.searchInput.value;
    renderGrid();
  });
  els.searchClear.hidden = !els.searchInput.value;
  els.searchClear.onclick = () => {
    els.searchInput.value = "";
    state.query = "";
    els.searchClear.hidden = true;
    els.searchInput.focus();
    renderGrid();
  };
  els.categoryFilter.addEventListener("change", () => {
    state.filters.categoryId = els.categoryFilter.value;
    syncCategoryPills();
    renderGrid();
  });
  els.tagFilter.addEventListener("change", () => {
    state.filters.tagId = els.tagFilter.value;
    renderGrid();
  });
  els.sizeFilter.addEventListener("change", () => {
    state.filters.size = els.sizeFilter.value;
    renderGrid();
  });
  els.newProductBtn.onclick = () => {
    openProductForm({ product: null, categories: state.categories, tags: state.tags, onSaved: () => {} });
  };
  els.manageBtn.onclick = () => {
    openCategoryTagManager({ getProducts: () => state.allProducts, onChanged: async () => { await loadMeta(); rebuildIndex(); renderGrid(); } });
  };
  document.getElementById("btn-deleted").onclick = openRecentlyDeleted;
  document.getElementById("btn-backup").onclick = downloadBackup;

  // Category quick-filter pills (mobile) — same state.filters.categoryId
  // the dropdown drives, kept in sync both directions so opening the
  // drawer after tapping a pill (or vice versa) never shows a stale value.
  els.categoryPills?.addEventListener("click", e => {
    const btn = e.target.closest(".pill-btn");
    if (!btn) return;
    state.filters.categoryId = btn.dataset.id;
    els.categoryFilter.value = btn.dataset.id;
    syncCategoryPills();
    renderGrid();
  });

  // Filters drawer (mobile) — open/close only; the selects inside already
  // filter live via the handlers above, so "Apply" just dismisses the sheet.
  const openFilters = () => { els.filtersPanel.classList.add("open"); els.filtersBackdrop.hidden = false; };
  const closeFilters = () => { els.filtersPanel.classList.remove("open"); els.filtersBackdrop.hidden = true; };
  els.filtersBtn?.addEventListener("click", openFilters);
  els.filtersCloseBtn?.addEventListener("click", closeFilters);
  els.filtersApplyBtn?.addEventListener("click", closeFilters);
  els.filtersBackdrop?.addEventListener("click", closeFilters);

  wireNav();
}

function syncCategoryPills() {
  els.categoryPills?.querySelectorAll(".pill-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.id === state.filters.categoryId);
  });
}

function openRecentlyDeleted() {
  const deleted = state.allProducts.filter(p => p.deleted);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Recently Deleted</h2>
        <button class="btn-icon modal-close">&times;</button>
      </div>
      <div class="modal-body">
        ${deleted.length
          ? deleted.map(p => `
              <div class="chip-row" data-id="${p.id}" style="justify-content:space-between; width:100%;">
                <span>${escapeHtml(p.master_code)} — ${escapeHtml(p.name)}</span>
                <button class="btn btn-secondary btn-restore" data-id="${p.id}">Restore</button>
              </div>
            `).join("")
          : `<p class="muted">Nothing here — deleted products show up so you can bring them back.</p>`}
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary modal-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll(".modal-close").forEach(btn => btn.onclick = () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll(".btn-restore").forEach(btn => {
    btn.onclick = async () => {
      await restoreProduct(btn.dataset.id);
      toast("Product restored");
      overlay.remove();
    };
  });
}

async function downloadBackup() {
  try {
    const data = await exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vhm-inventory-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Backup downloaded");
  } catch (e) {
    toast("Backup failed: " + e.message, "error");
  }
}

let cycleTabInitialized = false;
let unsubscribeCycleTab = null;
let dashTab = null;            // the 📊 Dashboard, set up the first time it is opened
// tabs that reuse the Products tab's live product list instead of opening their own Firestore listener
const productWatchers = new Set();
function wireNav() {
  const navProducts = document.getElementById("nav-products");
  const navCycle = document.getElementById("nav-cycle");
  const cycleView = document.getElementById("cycle-view");
  const navDash = document.getElementById("nav-dash");
  const dashView = document.getElementById("dash-view");
  const productsView = document.getElementById("products-view");
  const toolbar = document.getElementById("products-toolbar");
  const toolbarActions = document.getElementById("products-toolbar-actions");

  // one view at a time; the products toolbar only belongs to the Products view
  function show(which) {
    navProducts.classList.toggle("active", which === "products");
    navCycle.classList.toggle("active", which === "cycle");
    cycleView.hidden = which !== "cycle";
    navDash.classList.toggle("active", which === "dash");
    dashView.hidden = which !== "dash";
    productsView.hidden = which !== "products";
    toolbar.hidden = which !== "products";
    toolbarActions.hidden = which !== "products";
  }

  navProducts.onclick = () => show("products");

  navCycle.onclick = () => {
    show("cycle");
    if (!cycleTabInitialized) {
      cycleTabInitialized = true;
      unsubscribeCycleTab = initCycleTab(cycleView, {
        getProducts: () => state.allProducts,
        onProducts: fn => { productWatchers.add(fn); return () => productWatchers.delete(fn); },
      });
    } else cycleView.querySelector("#cy-input")?.focus();
  };

  navDash.onclick = () => {
    show("dash");
    if (!dashTab) {
      dashTab = initDashboardTab(dashView, {
        getProducts: () => state.allProducts,
        onProducts: fn => { productWatchers.add(fn); return () => productWatchers.delete(fn); },
        getCategories: () => state.categories,
        openProduct: p => openProductDetail(p, {
          category: state.categoriesById[p.category_id],
          tags: (p.tag_ids || []).map(id => state.tagsById[id]).filter(Boolean),
        }),
      });
    }
    dashTab.show();
  };
}

let unsubscribeProducts = null;

async function startApp() {
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app-shell").hidden = false;
  try {
    await loadMeta();
    wireToolbar();
    document.getElementById("btn-logout").onclick = async () => {
      unsubscribeProducts?.();
      await logout();
    };
    startSizes();
    onSizes(() => { if (state.searchIndex.length) renderGrid(); else renderSizesStamp(); });
    unsubscribeProducts = subscribeProducts(products => {
      state.allProducts = products;
      state.products = products.filter(p => !p.deleted);
      rebuildIndex();
      renderGrid();
      productWatchers.forEach(fn => fn(products));
    });
  } catch (err) {
    console.error(err);
    toast("Failed to load data — check Firestore rules & that Auth is enabled", "error");
  }
}

function showLogin() {
  unsubscribeProducts?.();
  // stop the 📍 Scan tab too, so it is set up fresh on the next sign-in
  unsubscribeCycleTab?.();
  unsubscribeCycleTab = null;
  cycleTabInitialized = false;
  dashTab?.stop();
  dashTab = null;
  const dv = document.getElementById("dash-view");
  if (dv) dv.innerHTML = "";
  const cycleView = document.getElementById("cycle-view");
  if (cycleView) cycleView.innerHTML = "";
  document.getElementById("app-shell").hidden = true;
  const loginScreen = document.getElementById("login-screen");
  loginScreen.hidden = false;

  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");
  form.onsubmit = async e => {
    e.preventDefault();
    errorEl.hidden = true;
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const submitBtn = document.getElementById("login-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";
    try {
      await login(email, password);
      // onAuthStateChanged (below) picks up the change and calls startApp()
    } catch (err) {
      errorEl.textContent = friendlyAuthError(err);
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign In";
    }
  };
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Wrong email or password.";
  }
  if (code.includes("too-many-requests")) {
    return "Too many attempts — wait a moment and try again.";
  }
  if (code.includes("invalid-email")) {
    return "That doesn't look like a valid email.";
  }
  return "Sign-in failed: " + (err?.message || "unknown error");
}

watchAuth(user => {
  if (user) startApp();
  else showLogin();
});
