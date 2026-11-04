// ============================================================================
// product-detail.js — read-only "Quick View" popup.
// Tapping a product's code opens this: photo, category, tags, price,
// locations, and the full description in one window — on mobile and
// desktop alike — without opening the Edit form or leaving the grid.
// ============================================================================

import { badge, escapeHtml, openGallery } from "./ui-components.js";
import { LOCATION_FIELDS } from "./constants.js";

export function openProductDetail(product, { category, tags }) {
  const cover = product.images?.[0]?.url || "";
  const prices = (product.variants || []).map(v => Number(v.price) || 0).filter(n => n > 0);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const priceLabel = minPrice === null ? "—" : minPrice === maxPrice ? `$${minPrice.toFixed(2)}` : `$${minPrice.toFixed(2)} – $${maxPrice.toFixed(2)}`;
  const totalStock = (product.variants || []).reduce((sum, v) => sum + (Number(v.stock_quantity) || 0), 0);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal modal-lg product-detail-modal">
      <div class="modal-header">
        <h2>${escapeHtml(product.master_code)}</h2>
        <button class="btn-icon modal-close" title="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="detail-image" ${product.images?.length ? 'id="detail-image"' : ""}>
          ${cover ? `<img src="${cover}" alt="${escapeHtml(product.name)}" />` : `<div class="no-image">No image</div>`}
          ${product.images?.length > 1 ? `<span class="image-count">${product.images.length} photos — tap to view</span>` : ""}
        </div>
        <div class="detail-locations">
          <span class="loc-chip loc-chip-storage" title="Sample location (display piece)">👕 ${product[LOCATION_FIELDS.sample] ? escapeHtml(product[LOCATION_FIELDS.sample]) : "—"}</span>
          <span class="loc-chip loc-chip-sample" title="Storage location (actual stock)">📦 ${product[LOCATION_FIELDS.stock] ? escapeHtml(product[LOCATION_FIELDS.stock]) : "—"}</span>
          <span class="price-tag detail-price-tag">${priceLabel}</span>
        </div>
        <h3 class="detail-title">${escapeHtml(product.name)}</h3>
        <div class="card-tags">
          ${category ? badge(category.name, category.color_code) : ""}
          ${tags.map(t => badge(t.name, t.color_code)).join(" ")}
        </div>
        ${product.description ? `<p class="detail-description muted">${escapeHtml(product.description)}</p>` : ""}
        <div class="card-stock ${totalStock === 0 ? "stock-zero" : ""}">Total stock: ${totalStock}</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
  overlay.querySelectorAll(".modal-close").forEach(btn => btn.onclick = close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  const imgEl = overlay.querySelector("#detail-image");
  if (imgEl) {
    imgEl.style.cursor = "pointer";
    imgEl.onclick = () => openGallery(product.images, 0);
  }
}
