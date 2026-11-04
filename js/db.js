// ============================================================================
// db.js — the ONLY file that talks to Firebase directly.
// Every other file goes through the functions exported here. This is the
// "decoupled" boundary: swap Firestore for something else later and only
// this file needs to change.
// ============================================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDocs, getDoc, addDoc, setDoc,
  updateDoc, deleteDoc, query, orderBy, onSnapshot, writeBatch, serverTimestamp,
  runTransaction, where, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";
import { auth } from "./auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const dbFs = getFirestore(app);
export const storage = getStorage(app);

function currentUserEmail() {
  return auth.currentUser?.email || null;
}

// ---------- Categories ----------
export async function listCategories() {
  const snap = await getDocs(query(collection(dbFs, "categories"), orderBy("name")));
  // ...d.data() spread FIRST, id: d.id LAST — the real Firestore document
  // id must always win over anything named "id" that ended up stored
  // inside the document's own data (see the saveProduct comment below for
  // exactly how that happens and why it's dangerous if id: d.id comes first).
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}
export async function saveCategory(cat) {
  if (cat.id) {
    const { id, ...rest } = cat;
    await updateDoc(doc(dbFs, "categories", id), rest);
    return id;
  }
  const { id, ...rest } = cat; // strip any stray id before creating — see saveProduct
  const ref_ = await addDoc(collection(dbFs, "categories"), rest);
  return ref_.id;
}
export async function deleteCategory(id) {
  await deleteDoc(doc(dbFs, "categories", id));
}

// ---------- Tags ----------
export async function listTags() {
  const snap = await getDocs(query(collection(dbFs, "tags"), orderBy("name")));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}
export async function saveTag(tag) {
  if (tag.id) {
    const { id, ...rest } = tag;
    await updateDoc(doc(dbFs, "tags", id), rest);
    return id;
  }
  const { id, ...rest } = tag; // strip any stray id before creating — see saveProduct
  const ref_ = await addDoc(collection(dbFs, "tags"), rest);
  return ref_.id;
}
export async function deleteTag(id) {
  await deleteDoc(doc(dbFs, "tags", id));
}

// ---------- Products (with embedded variants array — simplest reliable
// model for Firestore at boutique scale; avoids the "shared-blob" bug
// pattern from earlier tools since each product is its own document) ----
// { serverTimestamps: "estimate" } matters here: right after this device
// creates or edits a product, its own write shows up locally as "pending"
// before the server confirms it, and by default Firestore reports a
// pending serverTimestamp() field as null. Since the query below is
// ordered BY that same field (updated_at), a null value can sort the
// brand-new/just-edited product out of where it belongs (it can briefly
// look like it didn't get added, especially on a slow connection) until
// the server round-trip finishes. "estimate" uses this device's clock as
// a placeholder immediately, so it sorts correctly from the first frame
// and simply gets nudged to the exact right spot once the server confirms.
const TIMESTAMP_OPTS = { serverTimestamps: "estimate" };

export async function listProducts() {
  const snap = await getDocs(query(collection(dbFs, "products"), orderBy("updated_at", "desc")));
  // ...d.data() FIRST, id: d.id LAST — see the note in saveProduct about
  // why a stored "id" field inside the document must never win over the
  // real Firestore document id.
  return snap.docs.map(d => ({ ...d.data(TIMESTAMP_OPTS), id: d.id }));
}

// ---------- Product list: device cache + "only download what changed" ----------
// Reading the whole products collection on every open/refresh cost one read
// per product (2,000+ per open, per device). Now:
//   - this device keeps the product list (IndexedDB) between opens;
//   - on open it shows the cached list at once and asks Firestore only for
//     products whose updated_at is newer than the newest one it already has
//     (usually 0–20 reads instead of 2,000+);
//   - that same small query stays live, so edits from other staff still
//     appear within seconds (1 read per changed product, as before);
//   - once a week (or with no cache) it reads everything once, which also
//     catches anything changed outside the app (e.g. a product removed in the
//     Firebase console).
// Every write in this file sets updated_at, including archive/restore, so a
// soft delete reaches other devices too. All tabs share ONE listener.
const PCACHE = { key: "products_v1", fullEveryMs: 7 * 864e5 };
const pc = { docs: new Map(), maxMs: 0, fullAt: 0, loaded: false };
const productSubscribers = new Set();
let productListenerStop = null, productSyncStarted = false;

const tsMs = v => (v && typeof v.toMillis === "function") ? v.toMillis() : (typeof v === "number" ? v : 0);
// Timestamps can't be stored in IndexedDB as-is (they lose their methods): kept as { __ts: millis }
function packTs(v) {
  if (v === null || v === undefined) return v;
  if (typeof v.toMillis === "function") return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(packTs);
  if (typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = packTs(x); return o; }
  return v;
}
function unpackTs(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(unpackTs);
  if (typeof v === "object") { if (typeof v.__ts === "number" && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts); const o = {}; for (const [k, x] of Object.entries(v)) o[k] = unpackTs(x); return o; }
  return v;
}
const cacheDb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open("vhminv_cache", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const d = await this.open(); return await new Promise(res => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const d = await this.open(); return await new Promise(res => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); } catch (e) { return false; } },
};
function productList() { return [...pc.docs.values()].sort((a, b) => tsMs(b.updated_at) - tsMs(a.updated_at)); }   // newest first, as before
function emitProducts() { const list = productList(); productSubscribers.forEach(cb => { try { cb(list); } catch (e) { console.error(e); } }); }
let persistTimer = null;
function persistProducts() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => cacheDb.set(PCACHE.key, { maxMs: pc.maxMs, fullAt: pc.fullAt, docs: [...pc.docs.values()].map(packTs) }), 800);
}
async function startProductSync() {
  const c = await cacheDb.get(PCACHE.key);
  if (c && Array.isArray(c.docs) && c.maxMs && Date.now() - (c.fullAt || 0) < PCACHE.fullEveryMs) {
    c.docs.forEach(d => { const x = unpackTs(d); pc.docs.set(x.id, x); });
    pc.maxMs = c.maxMs; pc.fullAt = c.fullAt; pc.loaded = true;
    emitProducts();                                   // the cached list shows at once
  } else { pc.docs.clear(); pc.maxMs = 0; pc.fullAt = Date.now(); }
  if (!productSubscribers.size) { productSyncStarted = false; return; }   // everyone left while the cache was loading
  const col = collection(dbFs, "products");
  // ">" newest-known minus 1 ms = also re-reads the newest product (1 read) so nothing written in the same millisecond is missed
  const q = pc.maxMs ? query(col, where("updated_at", ">", Timestamp.fromMillis(pc.maxMs - 1)), orderBy("updated_at")) : query(col, orderBy("updated_at"));
  let first = true;
  productListenerStop = onSnapshot(q, snap => {
    const changes = snap.docChanges();
    changes.forEach(ch => {
      // "removed" = the product left this "changed since" window; it still exists (deletes in this app are soft) — keep it
      if (ch.type === "removed") return;
      const d = { ...ch.doc.data(TIMESTAMP_OPTS), id: ch.doc.id };
      pc.docs.set(d.id, d);
      // only server-confirmed times move the sync point (a pending local write only has this device's clock estimate)
      if (!ch.doc.metadata.hasPendingWrites) pc.maxMs = Math.max(pc.maxMs, tsMs(d.updated_at));
    });
    if (first || changes.length) { first = false; pc.loaded = true; emitProducts(); persistProducts(); }
  }, err => console.error("Product sync failed", err));
}
export function subscribeProducts(callback) {
  productSubscribers.add(callback);
  if (!productSyncStarted) { productSyncStarted = true; startProductSync(); }
  else if (pc.loaded) setTimeout(() => { if (productSubscribers.has(callback)) callback(productList()); }, 0);
  return () => {
    productSubscribers.delete(callback);
    if (!productSubscribers.size) {                  // last tab left (e.g. sign out): stop the one listener
      productListenerStop?.(); productListenerStop = null; productSyncStarted = false;
      pc.docs.clear(); pc.loaded = false;
    }
  };
}

export async function getProduct(id) {
  const snap = await getDoc(doc(dbFs, "products", id));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

export async function saveProduct(product) {
  // Strip id from the stored fields in BOTH branches below — product-form.js
  // always includes `id` in the object it builds (null for a brand-new
  // product, the real id when editing), and this is the one place that
  // ever writes a whole product document. Missing this on the *create*
  // branch was a real, already-shipped bug: a new product's payload had
  // id: null spread into `payload` below, and nothing ever removed it
  // before addDoc — so every product created through this app got a
  // literal id: null field saved INSIDE its own document data (separate
  // from, and shadowing, the real auto-generated Firestore document id).
  // Every list/read function used to do `{ id: d.id, ...d.data() }`, and
  // object spread lets later keys win — so that stored `id: null` field
  // silently overwrote the real id on every product read afterward,
  // meaning every delete/edit/scan action on that product tried to
  // operate on "products/null" and failed. Fixed on both ends: this strip
  // on write, and id: d.id placed LAST (winning) on every read above.
  const { id: _ignoredId, ...productFields } = product;
  const payload = { ...productFields, updated_at: serverTimestamp(), updated_by: currentUserEmail() };
  if (product.id) {
    await setDoc(doc(dbFs, "products", product.id), payload, { merge: true });
    return product.id;
  }
  payload.created_at = serverTimestamp();
  payload.created_by = currentUserEmail();
  payload.deleted = false;
  const ref_ = await addDoc(collection(dbFs, "products"), payload);
  return ref_.id;
}

// Soft delete: products are never actually removed by normal use of the
// app — "Delete" just hides them (deleted: true) so a wrong click can be
// undone. True permanent removal only happens by clearing it out directly
// in the Firebase console, on purpose, separately from everyday use.
export async function archiveProduct(id) {
  await updateDoc(doc(dbFs, "products", id), {
    deleted: true,
    deleted_at: serverTimestamp(),
    deleted_by: currentUserEmail(),
    updated_at: serverTimestamp(),           // so other devices' "only what changed" sync sees the delete
    updated_by: currentUserEmail(),
  });
}

export async function restoreProduct(id) {
  await updateDoc(doc(dbFs, "products", id), {
    deleted: false,
    deleted_at: null,
    deleted_by: null,
    updated_at: serverTimestamp(),           // so other devices see the restore
    updated_by: currentUserEmail(),
  });
}

// Inline product-level patch (quick-edit without reopening the modal) —
// used for fields that belong to the product as a whole rather than to any
// one variant, like the storage/sample location chips on the card.
export async function patchProduct(productId, patch) {
  await updateDoc(doc(dbFs, "products", productId), {
    ...patch,
    updated_at: serverTimestamp(),
    updated_by: currentUserEmail(),
  });
}

// Inline single-variant patch (quick-edit without reopening the modal, and
// the Live tab's scan-in/scan-out actions). Runs as a transaction — plain
// read-then-write here would lose an update if two staff scan/edit the
// same product's variants at close to the same moment (a real scenario
// for the Live tab specifically): both would read the same starting
// state, and whichever write lands second would silently overwrite the
// first's change. A transaction retries automatically if that happens
// instead of losing either update.
export async function patchVariant(productId, variantIndex, patch) {
  const productRef = doc(dbFs, "products", productId);
  await runTransaction(dbFs, async transaction => {
    const snap = await transaction.get(productRef);
    if (!snap.exists()) throw new Error("Product not found");
    const variants = [...(snap.data().variants || [])];
    variants[variantIndex] = { ...variants[variantIndex], ...patch };
    transaction.update(productRef, {
      variants,
      updated_at: serverTimestamp(),
      updated_by: currentUserEmail(),
    });
  });
}

// ---------- Backup ----------
// Pulls everything (categories, tags, every product including soft-deleted
// ones) into one plain object, for the "Download Backup" button in app.js.
// This is the safety net while there's no automatic server-side backup.
export async function exportAllData() {
  const [categories, tags, products] = await Promise.all([listCategories(), listTags(), listProducts()]);
  return {
    exported_at: new Date().toISOString(),
    categories: categories.map(serializeTimestamps),
    tags: tags.map(serializeTimestamps),
    products: products.map(serializeTimestamps),
  };
}

// Firestore Timestamp objects don't survive JSON.stringify as readable
// dates (they'd serialize as {} or internal fields) — convert every one,
// at any depth, to a plain ISO string so the backup file is actually
// human-readable and re-importable.
function serializeTimestamps(value) {
  if (value === null || value === undefined) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeTimestamps);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeTimestamps(v);
    return out;
  }
  return value;
}

// ---------- Images ----------
export async function uploadProductImage(productId, file, order) {
  const path = `products/${productId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  // a photo never changes once uploaded (a new photo gets a new name), so browsers may keep it
  // for a year instead of downloading it again on every open
  await uploadBytes(storageRef, file, { cacheControl: "public, max-age=31536000, immutable" });
  const url = await getDownloadURL(storageRef);
  return { url, path, order, name: file.name };
}

export async function deleteProductImage(path) {
  try {
    await deleteObject(ref(storage, path));
  } catch (e) {
    console.warn("Image delete failed (may already be gone):", e.message);
  }
}

// ---------- 🔄 Cycle log (Stock → Sample → Live Room → Stock …) ----------
// Every scan in the Cycle tab = ONE batch of 2 writes:
//   cycle_log/<auto id>  → the move itself (append-only history)
//   products/<id>        → cycle_stage / cycle_at / cycle_round (where it is NOW,
//                          so every device sees it through the normal product sync
//                          without any extra listener or read)
// Reads happen only when someone opens a code's history or loads a day's log.
export async function logCycleMove(product, move, extraPatch = {}) {
  const batch = writeBatch(dbFs);
  const logRef = doc(collection(dbFs, "cycle_log"));
  const by = currentUserEmail();
  batch.set(logRef, { ...move, product_id: product.id, master_code: product.master_code || "", at: serverTimestamp(), at_ms: Date.now(), by });
  batch.update(doc(dbFs, "products", product.id), {
    cycle_stage: move.to,
    cycle_at: new Date().toISOString(),
    cycle_round: move.round,
    ...extraPatch,                         // e.g. the sample container location scanned with a move to Sample
    updated_at: serverTimestamp(),
    updated_by: by,
  });
  await batch.commit();
  return logRef.id;
}

// Undo = remove that log line and put the product's stage back exactly as it was.
export async function undoCycleMove(logId, productId, prev) {
  const batch = writeBatch(dbFs);
  batch.delete(doc(dbFs, "cycle_log", logId));
  batch.update(doc(dbFs, "products", productId), {
    ...prev,                               // every field the move changed, as it was before
    cycle_stage: prev.cycle_stage ?? null,
    cycle_at: prev.cycle_at ?? null,
    cycle_round: prev.cycle_round ?? 0,
    updated_at: serverTimestamp(),
    updated_by: currentUserEmail(),
  });
  await batch.commit();
}

// One code's full history (single-field filter → no composite index needed; sorted here).
export async function listCycleLogForProduct(productId) {
  const snap = await getDocs(query(collection(dbFs, "cycle_log"), where("product_id", "==", productId)));
  return snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (b.at_ms || 0) - (a.at_ms || 0));
}

// Every move between two times (ms) — for the day log / CSV. Single field → no index needed.
export async function listCycleLogBetween(fromMs, toMs) {
  const snap = await getDocs(query(collection(dbFs, "cycle_log"),
    where("at_ms", ">=", fromMs), where("at_ms", "<", toMs), orderBy("at_ms", "desc")));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

// ---------- Manager PIN (protects deleting tags / categories) ----------
// Stored only as a SHA-256 hash in settings/admin. It's a guard against
// accidental deletes by staff, not a security wall (any signed-in account can
// still write Firestore directly).
// Plain-JS SHA-256 (works on http, https and file:// alike — crypto.subtle only exists on https).
async function sha256(text) {
  const K = [], H = [], isPrime = n => { for (let f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
  const frac = x => ((x - Math.floor(x)) * 0x100000000) | 0;
  for (let n = 2, i = 0; i < 64; n++) if (isPrime(n)) { if (i < 8) H[i] = frac(Math.pow(n, 1 / 2)); K[i++] = frac(Math.pow(n, 1 / 3)); }
  const bytes = [...new TextEncoder().encode(text)], bitLen = bytes.length * 8;
  bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n)), W = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    for (let i = 16; i < 64; i++) { const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  return H.map(v => (v >>> 0).toString(16).padStart(8, "0")).join("");
}
export async function hasManagerPin() {
  const snap = await getDoc(doc(dbFs, "settings", "admin"));
  return !!(snap.exists() && snap.data().pin_hash);
}
export async function checkManagerPin(pin) {
  const snap = await getDoc(doc(dbFs, "settings", "admin"));
  return snap.exists() && snap.data().pin_hash === await sha256("vhm-inventory:" + pin);
}
export async function setManagerPin(pin) {
  await setDoc(doc(dbFs, "settings", "admin"), { pin_hash: await sha256("vhm-inventory:" + pin), pin_set_at: serverTimestamp(), pin_set_by: currentUserEmail() }, { merge: true });
}

// Soft delete / restore for a tag or category: the document stays (deleted: true),
// so products keep their link and Restore brings everything back as it was.
export async function setMetaDeleted(kind, id, deleted) {
  await updateDoc(doc(dbFs, kind === "cat" ? "categories" : "tags", id), {
    deleted,
    deleted_at: deleted ? serverTimestamp() : null,
    deleted_by: deleted ? currentUserEmail() : null,
  });
}
