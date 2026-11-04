// ============================================================================
// ui-components.js — small reusable UI pieces: color badges, toasts,
// the image gallery viewer. Pure DOM/string helpers, no Firebase here.
// ============================================================================

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export function badge(name, colorHex) {
  // Only ever accept an actual hex color into the style attribute — a
  // category/tag document edited directly (outside this app's own color
  // picker, e.g. via the Firebase console or API) could otherwise contain
  // anything, and this string isn't HTML-escaped.
  const safeHex = HEX_COLOR_RE.test(colorHex || "") ? colorHex : "#6b7280";
  const fg = readableTextColor(safeHex);
  return `<span class="badge" style="background:${safeHex};color:${fg}">${escapeHtml(name)}</span>`;
}

export function readableTextColor(hex) {
  if (!hex) return "#fff";
  const c = hex.replace("#", "");
  if (c.length !== 6) return "#fff";
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111" : "#fff";
}

let toastTimer;
export function toast(message, type = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.className = `toast toast-${type} show`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

export function openGallery(images, startIndex = 0) {
  const overlay = document.createElement("div");
  overlay.className = "gallery-overlay";
  let idx = startIndex;
  render();
  document.body.appendChild(overlay);

  function render() {
    const img = images[idx];
    overlay.innerHTML = `
      <div class="gallery-close" title="Close">&times;</div>
      <div class="gallery-nav gallery-prev">&#8249;</div>
      <img class="gallery-img" src="${img?.url || ""}" alt="" />
      <div class="gallery-nav gallery-next">&#8250;</div>
      <div class="gallery-count">${idx + 1} / ${images.length}</div>
    `;
    overlay.querySelector(".gallery-close").onclick = () => overlay.remove();
    overlay.querySelector(".gallery-prev").onclick = () => { idx = (idx - 1 + images.length) % images.length; render(); };
    overlay.querySelector(".gallery-next").onclick = () => { idx = (idx + 1) % images.length; render(); };
  }
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

// Custom confirm dialog — used instead of the browser's native confirm().
// Kiosk/POS browsers frequently disable JS dialogs (confirm/alert/prompt)
// outright for security reasons; when that happens confirm() just returns
// false immediately with no visible dialog at all, which looks exactly
// like "the Delete button doesn't work." This never depends on that API.
export function confirmDialog(message, { confirmLabel = "Delete", cancelLabel = "Cancel" } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-body"><p style="margin:0;">${escapeHtml(message)}</p></div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="confirm-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="btn btn-danger" id="confirm-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const finish = result => { overlay.remove(); resolve(result); };
    overlay.querySelector("#confirm-cancel").onclick = () => finish(false);
    overlay.querySelector("#confirm-ok").onclick = () => finish(true);
    overlay.addEventListener("click", e => { if (e.target === overlay) finish(false); });
  });
}

export function escapeHtml(s) {
  return (s || "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
