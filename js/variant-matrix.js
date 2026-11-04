// ============================================================================
// variant-matrix.js — Dynamic Variant Matrix component.
// Given a set of sizes and colors, auto-generates one variant row per
// size×color combination. Also renders the editable table (POS code,
// alternate codes, stock, price) used inside the product form.
// ============================================================================

import { SIZES, VARIANT_TYPES, emptyVariant } from "./constants.js";
import { escapeHtml } from "./ui-components.js";

// Auto-generate variants for the chosen sizes × colors, keeping any
// existing variant (matched by size+color_name) so re-generating after
// adding one more color doesn't wipe out codes/stock you already entered.
export function generateVariants(existingVariants, { type, sizes, colors }) {
  const existingByKey = {};
  for (const v of existingVariants || []) {
    existingByKey[`${v.size}__${(v.color_name || "").toLowerCase()}`] = v;
  }
  const out = [];
  for (const color of colors) {
    for (const size of sizes) {
      const key = `${size}__${color.name.toLowerCase()}`;
      if (existingByKey[key]) {
        out.push(existingByKey[key]);
      } else {
        out.push(emptyVariant({ type, size, color_name: color.name, color_hex: color.hex }));
      }
    }
  }
  return out;
}

export function renderVariantTable(variants) {
  if (!variants.length) {
    return `<p class="muted">No variants yet — pick sizes and colors above, then click "Generate Variants".</p>`;
  }
  const rows = variants.map((v, i) => `
    <tr data-idx="${i}">
      <td data-label="Color"><span class="swatch" style="background:${v.color_hex}"></span> ${escapeHtml(v.color_name)}</td>
      <td data-label="Size">${v.size}</td>
      <td data-label="Type">
        <select class="v-type" data-idx="${i}">
          ${VARIANT_TYPES.map(t => `<option value="${t}" ${t === v.type ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </td>
      <td data-label="POS Code"><input class="v-pos" data-idx="${i}" type="text" value="${escapeHtml(v.pos_code)}" placeholder="P001" /></td>
      <td data-label="Alt Codes"><input class="v-alt" data-idx="${i}" type="text" value="${escapeHtml((v.alternate_codes || []).join(", "))}" placeholder="ALT-001, POS-001-A" /></td>
      <td data-label="Stock"><input class="v-stock" data-idx="${i}" type="number" min="0" value="${v.stock_quantity}" /></td>
      <td data-label="Price"><input class="v-price" data-idx="${i}" type="number" min="0" step="0.01" value="${v.price}" /></td>
      <td class="v-remove-cell"><button class="btn-icon v-remove" data-idx="${i}" title="Remove variant">&times;</button></td>
    </tr>
  `).join("");

  return `
    <table class="variant-table">
      <thead>
        <tr>
          <th>Color</th><th>Size</th><th>Type</th><th>POS Code</th>
          <th>Alternate Codes</th><th>Stock</th><th>Price</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Reads the current state of the rendered table back into a variants array.
export function readVariantTable(container, baseVariants) {
  const variants = baseVariants.map(v => ({ ...v }));
  container.querySelectorAll(".v-type").forEach(el => {
    variants[+el.dataset.idx].type = el.value;
  });
  container.querySelectorAll(".v-pos").forEach(el => {
    variants[+el.dataset.idx].pos_code = el.value.trim();
  });
  container.querySelectorAll(".v-alt").forEach(el => {
    variants[+el.dataset.idx].alternate_codes = el.value.split(",").map(s => s.trim()).filter(Boolean);
  });
  container.querySelectorAll(".v-stock").forEach(el => {
    variants[+el.dataset.idx].stock_quantity = Number(el.value) || 0;
  });
  container.querySelectorAll(".v-price").forEach(el => {
    variants[+el.dataset.idx].price = Number(el.value) || 0;
  });
  return variants;
}

export { SIZES };
