// Parse the size and weight guide already stored in a product description.
// This module is intentionally independent of Firebase/the DOM so the parser
// can be tested with the real, occasionally messy, description text.

const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|F|FS|FREE|FREESIZE|(?:2[6-9]|3\d|4[0-6]))$/i;

export function normalizeGuideSize(value) {
  const size = String(value || "").trim().toUpperCase();
  return size === "XXL" ? "2XL" : size === "XXXL" ? "3XL" : size;
}

function sizeToken(value) {
  const clean = String(value || "").replace(/^[,;|/]+|[,;|/]+$/g, "");
  return SIZE_RE.test(clean) ? normalizeGuideSize(clean) : "";
}

export function parseGuide(description) {
  const weights = new Map();
  const madeSizes = new Set();
  let ignoreHeightSection = false;

  for (const raw of String(description || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /តម្លៃ|កូដ|\$/i.test(line)) continue;
    // Live Log messages may contain a separate height section. Its lines look
    // exactly like weight ranges (for example M: 160-170), so explicitly ignore
    // them until a later គីឡូ heading switches the parser back to weight mode.
    if (/^កម្ពស់/.test(line.replace(/[:：]/g, "").trim())) { ignoreHeightSection = true; continue; }
    if (/^គីឡ/.test(line.replace(/[:：]/g, "").trim())) { ignoreHeightSection = false; continue; }
    if (ignoreHeightSection) continue;

    // Examples accepted: "M :50KG-60KG", "L 60–70", "XL → 70 kg ~ 80".
    // The expression deliberately stops after the second number, so common
    // suffix typos such as "70KGM" do not invalidate an otherwise clear line.
    const weight = /^\s*(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|F|FS|FREE|FREESIZE|(?:2[6-9]|3\d|4[0-6]))\s*[:：→]?\s*(\d{2,3})\s*(?:kg)?\s*[-–—~]\s*(\d{2,3})/i.exec(line);
    if (weight) {
      const size = normalizeGuideSize(weight[1]);
      const min = Number(weight[2]), max = Number(weight[3]);
      if (min > 0 && max > min && max <= 300) {
        weights.set(size, { min, max });
        madeSizes.add(size);
      }
      continue;
    }

    const tokens = line.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const allSizes = tokens.map(sizeToken);
    const afterColour = tokens.slice(1).map(sizeToken);
    const sizes = allSizes.every(Boolean) ? allSizes
      : tokens.length > 1 && afterColour.every(Boolean) ? afterColour
      : null;
    if (sizes) sizes.forEach(size => madeSizes.add(size));
  }

  // A weight line explicitly names a made size. Keeping it in madeSizes also
  // supports descriptions that omit the separate colour/size-list lines.
  return { weights, madeSizes };
}

export function fitRange(rows, guide) {
  const ranges = [];
  for (const row of rows || []) {
    if (!(Number(row.qty) > 0)) continue;
    const range = guide?.weights?.get(normalizeGuideSize(row.size));
    if (range) ranges.push(range);
  }
  if (!ranges.length) return null;
  return {
    min: Math.min(...ranges.map(r => r.min)),
    max: Math.max(...ranges.map(r => r.max)),
  };
}

export const WEIGHT_BANDS = [
  { label: "Under 50", min: -Infinity, max: 50 },
  { label: "50–60", min: 50, max: 60 },
  { label: "60–70", min: 60, max: 70 },
  { label: "70–80", min: 70, max: 80 },
  { label: "80–90", min: 80, max: 90 },
  { label: "90+", min: 90, max: Infinity },
];

export function rangeFitsBand(range, band) {
  return range.max > band.min && range.min < band.max;
}
