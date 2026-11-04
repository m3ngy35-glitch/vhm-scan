// ============================================================================
// search.js — Global Search System.
// Client-side multi-field instant search with highlight matching.
// Works entirely on the in-memory product list (fine at boutique-catalog
// scale — hundreds to a few thousand products). Matches:
//   master_code, pos_code, alternate_codes, name, description, tag names,
//   category name, storage location, sample location.
// ============================================================================

function norm(s) {
  return (s || "").toString().toLowerCase().trim();
}

// Splits the haystack into individual whole "words" (codes, name words,
// etc.) — used only for exact-match lookups (see searchProducts below).
// Khmer characters are kept as word characters too, alongside letters/digits,
// so Khmer text tokenizes sensibly instead of getting shredded into pieces.
function wordsOf(haystack) {
  return new Set(haystack.split(/[^a-z0-9ក-៿]+/i).filter(Boolean));
}

export function buildSearchIndex(products, categoriesById, tagsById) {
  return products.map(p => {
    const posCodes = (p.variants || []).flatMap(v => [v.pos_code, ...(v.alternate_codes || [])]).filter(Boolean);
    const tagNames = (p.tag_ids || []).map(id => tagsById[id]?.name).filter(Boolean);
    const categoryName = categoriesById[p.category_id]?.name || "";
    const haystack = norm([
      p.master_code, p.name, p.description, categoryName, ...tagNames, ...posCodes,
      p.storage_location, p.sample_location,
    ].join(" | "));
    return { product: p, haystack, words: wordsOf(haystack), posCodes, tagNames, categoryName };
  });
}

// A trailing space after a term is the signal to match it EXACTLY (so
// "e9 " only finds a code that's exactly "e9", not "e91"/"e90"/"e900" —
// which a plain substring search would otherwise also match). Without
// that trailing space, matching stays substring-based as before, so
// typing "e9" while still typing continues to show those as candidates.
export function searchProducts(index, rawQuery, { categoryId, tagId, size } = {}) {
  const endsWithSpace = /\s$/.test(rawQuery || "");
  const q = norm(rawQuery);
  const terms = q.split(/\s+/).filter(Boolean);
  const exactLast = endsWithSpace && terms.length > 0;

  return index.filter(entry => {
    const p = entry.product;
    if (categoryId && p.category_id !== categoryId) return false;
    if (tagId && !(p.tag_ids || []).includes(tagId)) return false;
    if (size && !(p.variants || []).some(v => v.size === size)) return false;
    if (terms.length === 0) return true;
    return terms.every((t, i) => {
      const isExact = exactLast && i === terms.length - 1;
      return isExact ? entry.words.has(t) : entry.haystack.includes(t);
    });
  }).map(e => e.product);
}

// Wraps matches of `query` in <mark> for highlight-as-you-type display.
// Mirrors the exact-match rule above: a trailing space highlights only
// the whole-word match for that last term, not every occurrence inside
// a longer code.
export function highlight(text, rawQuery) {
  if (!text) return "";
  const endsWithSpace = /\s$/.test(rawQuery || "");
  const q = norm(rawQuery);
  if (!q) return escapeHtml(text);
  const rawTerms = q.split(/\s+/).filter(Boolean);
  const lastTerm = rawTerms[rawTerms.length - 1];
  const terms = [...rawTerms].sort((a, b) => b.length - a.length);
  let result = escapeHtml(text);
  terms.forEach(term => {
    const isExact = endsWithSpace && term === lastTerm;
    const pattern = escapeRegExp(escapeHtml(term));
    const re = isExact ? new RegExp(`\\b(${pattern})\\b`, "ig") : new RegExp(`(${pattern})`, "ig");
    result = result.replace(re, "<mark>$1</mark>");
  });
  return result;
}

// Exact code lookup for barcode/POS scanning (Live tab): finds the single
// product+variant whose pos_code or an alternate_code matches, ignoring
// case/whitespace (scanners sometimes add these inconsistently).
export function findVariantByCode(products, rawCode) {
  const code = norm(rawCode);
  if (!code) return null;
  for (const product of products) {
    const variants = product.variants || [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const codes = [v.pos_code, ...(v.alternate_codes || [])].map(norm);
      if (codes.includes(code)) {
        return { product, variant: v, variantIndex: i };
      }
    }
  }
  return null;
}

function escapeHtml(s) {
  return (s || "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
