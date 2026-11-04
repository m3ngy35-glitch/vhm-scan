// ============================================================================
// category-tag-manager.js — manage Categories and Tags (name + colour badge).
//
// Safe by design:
// - Rename / recolour in place: the tag keeps its id, so every product that has
//   it keeps it, and shows the new name at once. No delete-and-re-add.
// - Names are unique, ignoring capitals and extra spaces ("Polo" = " polo ").
// - Each tag shows how many products use it.
// - Delete needs the manager PIN, and is a soft delete: the tag moves to
//   "Deleted", products keep their link, and Restore brings it back as it was.
// ============================================================================

import { listCategories, saveCategory, listTags, saveTag, setMetaDeleted, hasManagerPin, checkManagerPin, setManagerPin } from "./db.js";
import { toast, escapeHtml } from "./ui-components.js";
import { DEFAULT_CATEGORY_COLOR, DEFAULT_TAG_COLOR } from "./constants.js";

const cleanName = s => (s || "").replace(/\s+/g, " ").trim();
const key = s => cleanName(s).toLowerCase();

export function openCategoryTagManager({ onChanged, getProducts }) {
  let changed = false;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Categories & Tags</h2>
        <button class="btn-icon modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p class="muted meta-help">Tap a name to rename it, tap the colour to change it — saved by itself, and every product keeps it. · ចុចលើឈ្មោះដើម្បីប្តូរ</p>
        <h3>Categories</h3>
        <div id="cat-list" class="meta-list"></div>
        <div class="form-row">
          <input id="cat-name" type="text" placeholder="New category name" />
          <input id="cat-color" type="color" value="${DEFAULT_CATEGORY_COLOR}" />
          <button id="cat-add" class="btn btn-secondary">Add</button>
        </div>
        <hr/>
        <h3>Tags</h3>
        <input id="tag-filter" class="meta-filter" type="search" placeholder="Find a tag · ស្វែងរក" />
        <div id="tag-list" class="meta-list"></div>
        <div class="form-row">
          <input id="tag-name" type="text" placeholder="New tag name" />
          <input id="tag-color" type="color" value="${DEFAULT_TAG_COLOR}" />
          <button id="tag-add" class="btn btn-secondary">Add</button>
        </div>
        <details id="deleted-box" class="meta-deleted"><summary>🗑 Deleted (<span id="deleted-count">0</span>) — restore · ស្តារវិញ</summary><div id="deleted-list"></div></details>
        <p class="muted meta-pin"><a href="#" id="pin-change">🔑 Change manager PIN</a></p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary modal-close">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const $ = s => overlay.querySelector(s);
  const close = () => { overlay.remove(); if (changed) onChanged?.(); };
  overlay.querySelectorAll(".modal-close").forEach(btn => btn.onclick = close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  let cats = [], tags = [];
  const usage = { cat: new Map(), tag: new Map() };
  function countUsage() {
    usage.cat.clear(); usage.tag.clear();
    (getProducts?.() || []).filter(p => !p.deleted).forEach(p => {
      if (p.category_id) usage.cat.set(p.category_id, (usage.cat.get(p.category_id) || 0) + 1);
      (p.tag_ids || []).forEach(t => usage.tag.set(t, (usage.tag.get(t) || 0) + 1));
    });
  }

  function row(item, kind) {
    const n = usage[kind].get(item.id) || 0;
    return `<div class="meta-row" data-id="${item.id}" data-kind="${kind}">
      <input type="color" class="meta-color" value="${/^#[0-9a-f]{6}$/i.test(item.color_code || "") ? item.color_code : "#6b7280"}" title="Change colour" />
      <input type="text" class="meta-name" value="${escapeHtml(item.name || "")}" spellcheck="false" />
      <span class="muted meta-count" title="Products using it">${n} product${n === 1 ? "" : "s"}</span>
      <button class="btn-icon meta-delete" title="Delete (manager PIN)">🗑</button>
    </div>`;
  }
  function render() {
    countUsage();
    const live = list => list.filter(x => !x.deleted);
    $("#cat-list").innerHTML = live(cats).map(c => row(c, "cat")).join("") || `<p class="muted">No categories yet.</p>`;
    const f = key($("#tag-filter").value);
    $("#tag-list").innerHTML = live(tags).filter(t => !f || key(t.name).includes(f)).map(t => row(t, "tag")).join("") || `<p class="muted">${f ? "No tag matches." : "No tags yet."}</p>`;
    const gone = [...cats.filter(c => c.deleted).map(c => ({ ...c, kind: "cat" })), ...tags.filter(t => t.deleted).map(t => ({ ...t, kind: "tag" }))];
    $("#deleted-count").textContent = gone.length;
    $("#deleted-box").hidden = !gone.length;
    $("#deleted-list").innerHTML = gone.map(x => `<div class="meta-row meta-row-deleted">
      <span class="badge" style="background:${/^#[0-9a-f]{3,8}$/i.test(x.color_code || "") ? x.color_code : "#6b7280"};color:#fff">${escapeHtml(x.name)}</span>
      <span class="muted">${x.kind === "cat" ? "category" : "tag"} · ${usage[x.kind].get(x.id) || 0} products still linked</span>
      <button class="btn btn-secondary meta-restore" data-id="${x.id}" data-kind="${x.kind}">Restore · ស្តារ</button></div>`).join("");
    wire();
  }

  function wire() {
    overlay.querySelectorAll(".meta-row[data-id]").forEach(el => {
      const id = el.dataset.id, kind = el.dataset.kind, list = kind === "cat" ? cats : tags, item = list.find(x => x.id === id);
      if (!item) return;
      const nameIn = el.querySelector(".meta-name"), colorIn = el.querySelector(".meta-color");
      // rename: saved on Enter or when leaving the box
      const saveName = async () => {
        const name = cleanName(nameIn.value);
        if (name === item.name) return;
        if (!name) { nameIn.value = item.name; return toast("Name can't be empty", "error"); }
        if (list.some(x => x.id !== id && key(x.name) === key(name))) { nameIn.value = item.name; return toast(`"${name}" already exists${list.find(x => x.id !== id && key(x.name) === key(name))?.deleted ? " (in Deleted — restore it instead)" : ""}`, "error"); }
        const old = item.name;
        try { await save(kind, { id, name }); item.name = name; changed = true; nameIn.value = name; flash(el); toast(`Renamed "${old}" → "${name}" on ${usage[kind].get(id) || 0} products`); }
        catch (e) { nameIn.value = old; toast("Rename failed: " + e.message, "error"); }
      };
      nameIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); nameIn.blur(); } if (e.key === "Escape") { nameIn.value = item.name; nameIn.blur(); } });
      nameIn.addEventListener("blur", saveName);
      colorIn.addEventListener("change", async () => {
        try { await save(kind, { id, color_code: colorIn.value }); item.color_code = colorIn.value; changed = true; flash(el); }
        catch (e) { toast("Colour not saved: " + e.message, "error"); }
      });
      el.querySelector(".meta-delete").onclick = async () => {
        const n = usage[kind].get(id) || 0;
        const ok = await askPin(`Delete ${kind === "cat" ? "category" : "tag"} "${item.name}"?${n ? ` It is on ${n} product${n === 1 ? "" : "s"}.` : ""} You can restore it from "Deleted".`);
        if (!ok) return;
        try { await setMetaDeleted(kind, id, true); item.deleted = true; changed = true; render(); toast(`"${item.name}" moved to Deleted`); }
        catch (e) { toast("Delete failed: " + e.message, "error"); }
      };
    });
    overlay.querySelectorAll(".meta-restore").forEach(b => b.onclick = async () => {
      const list = b.dataset.kind === "cat" ? cats : tags, item = list.find(x => x.id === b.dataset.id);
      if (list.some(x => x.id !== item.id && !x.deleted && key(x.name) === key(item.name))) return toast(`A "${item.name}" already exists — rename that one first`, "error");
      b.disabled = true;
      try { await setMetaDeleted(b.dataset.kind, item.id, false); item.deleted = false; changed = true; render(); toast(`"${item.name}" restored`); }
      catch (e) { toast("Restore failed: " + e.message, "error"); b.disabled = false; }
    });
  }
  const save = (kind, patch) => kind === "cat" ? saveCategory(patch) : saveTag(patch);
  const flash = el => { el.classList.add("meta-saved"); setTimeout(() => el.classList.remove("meta-saved"), 900); };

  async function load() {
    try { [cats, tags] = await Promise.all([listCategories(), listTags()]); render(); }
    catch (e) { toast("Failed to load categories/tags: " + e.message, "error"); }
  }

  async function add(kind) {
    const nameEl = $(kind === "cat" ? "#cat-name" : "#tag-name"), btn = $(kind === "cat" ? "#cat-add" : "#tag-add");
    const name = cleanName(nameEl.value), color_code = $(kind === "cat" ? "#cat-color" : "#tag-color").value, list = kind === "cat" ? cats : tags;
    if (!name) return toast(`Enter a ${kind === "cat" ? "category" : "tag"} name`, "error");
    const dup = list.find(x => key(x.name) === key(name));
    if (dup) return toast(dup.deleted ? `"${dup.name}" is in Deleted — restore it instead` : `"${dup.name}" already exists`, "error");
    btn.disabled = true;   // stops a double tap creating it twice
    try { await save(kind, { name, color_code, deleted: false }); nameEl.value = ""; changed = true; await load(); toast(`${kind === "cat" ? "Category" : "Tag"} added`); }
    catch (e) { toast("Failed to add: " + e.message, "error"); }
    finally { btn.disabled = false; }
  }
  $("#cat-add").onclick = () => add("cat");
  $("#tag-add").onclick = () => add("tag");
  $("#cat-name").addEventListener("keydown", e => { if (e.key === "Enter") add("cat"); });
  $("#tag-name").addEventListener("keydown", e => { if (e.key === "Enter") add("tag"); });
  $("#tag-filter").addEventListener("input", render);
  $("#pin-change").onclick = async e => { e.preventDefault(); if (await hasManagerPin() && !(await askPin("Enter the current manager PIN to change it."))) return; await createPin(true); };

  load();
}

// ---------- PIN dialogs ----------
function pinDialog(title, message, fields) {
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<div class="modal modal-sm"><div class="modal-body">
      <p style="margin:0 0 6px"><b>${escapeHtml(title)}</b></p><p class="muted" style="margin:0 0 12px">${escapeHtml(message)}</p>
      ${fields.map((f, i) => `<input type="password" inputmode="numeric" autocomplete="off" class="pin-input" data-i="${i}" placeholder="${escapeHtml(f)}" />`).join("")}
      <p class="pin-err" hidden></p></div>
      <div class="modal-footer"><button class="btn btn-secondary" data-a="no">Cancel</button><button class="btn btn-danger" data-a="ok">OK</button></div></div>`;
    document.body.appendChild(ov);
    const inputs = [...ov.querySelectorAll(".pin-input")];
    const done = v => { ov.remove(); resolve(v); };
    const err = m => { const e = ov.querySelector(".pin-err"); e.textContent = m; e.hidden = false; };
    const ok = () => done({ values: inputs.map(i => i.value), err });
    ov.querySelector('[data-a="no"]').onclick = () => done(null);
    ov.querySelector('[data-a="ok"]').onclick = ok;
    inputs.forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") ok(); }));
    setTimeout(() => inputs[0].focus(), 0);
  });
}
async function createPin(changing) {
  for (;;) {
    const r = await pinDialog(changing ? "New manager PIN" : "Set a manager PIN first", "Deleting tags and categories will ask for this PIN. At least 4 digits. Only give it to the manager. · លេខសម្ងាត់អ្នកគ្រប់គ្រង", ["New PIN", "Type it again"]);
    if (!r) return false;
    const [a, b] = r.values;
    if (!/^\d{4,}$/.test(a)) { toast("PIN must be at least 4 digits", "error"); continue; }
    if (a !== b) { toast("The two PINs are different", "error"); continue; }
    try { await setManagerPin(a); toast("Manager PIN saved"); return true; }
    catch (e) { toast("PIN not saved: " + e.message, "error"); return false; }
  }
}
export async function askPin(message) {
  if (!(await hasManagerPin())) { if (!(await createPin(false))) return false; }
  for (let tries = 0; tries < 3; tries++) {
    const r = await pinDialog("Manager PIN · លេខសម្ងាត់", message, ["PIN"]);
    if (!r) return false;
    if (await checkManagerPin(r.values[0])) return true;
    toast("Wrong PIN · លេខសម្ងាត់ខុស", "error");
  }
  return false;
}
