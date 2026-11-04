// ============================================================================
// image-upload.js — Image Uploader component.
// Drag-and-drop, preview thumbnails, reorder by dragging, remove.
// Uploads happen on save (uploadPendingImages), not on drop, so a user can
// still reorder/remove before committing.
// ============================================================================

import { uploadProductImage } from "./db.js";

export function createImageUploader(container, initialImages = []) {
  // state items: { url, path, order, name, file? (pending upload), isNew? }
  let items = initialImages.map((img, i) => ({ ...img, order: i }));
  let dragFromIdx = null;

  function render() {
    container.innerHTML = `
      <div class="uploader-drop" id="uploader-drop">
        Drag & drop images here, or click to choose files
        <input type="file" id="uploader-input" accept="image/*" multiple hidden />
      </div>
      <div class="uploader-grid">
        ${items.map((it, i) => `
          <div class="uploader-thumb" draggable="true" data-idx="${i}">
            <img src="${it.previewUrl || it.url}" alt="" />
            <button class="thumb-remove" data-idx="${i}" title="Remove">&times;</button>
            <span class="thumb-order">${i + 1}</span>
          </div>
        `).join("")}
      </div>
    `;
    wireEvents();
  }

  function wireEvents() {
    const drop = container.querySelector("#uploader-drop");
    const input = container.querySelector("#uploader-input");
    drop.onclick = () => input.click();
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("drag-over"); };
    drop.ondragleave = () => drop.classList.remove("drag-over");
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove("drag-over");
      addFiles(e.dataTransfer.files);
    };
    input.onchange = () => addFiles(input.files);

    container.querySelectorAll(".thumb-remove").forEach(btn => {
      btn.onclick = () => {
        const [removed] = items.splice(+btn.dataset.idx, 1);
        // Blob preview URLs aren't freed just because nothing references
        // them anymore — the browser keeps that memory until the page
        // closes or this is called explicitly. With the form opened many
        // times a day, that adds up.
        if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        items = items.map((it, i) => ({ ...it, order: i }));
        render();
      };
    });

    container.querySelectorAll(".uploader-thumb").forEach(el => {
      el.ondragstart = () => { dragFromIdx = +el.dataset.idx; };
      el.ondragover = e => e.preventDefault();
      el.ondrop = e => {
        e.preventDefault();
        const toIdx = +el.dataset.idx;
        if (dragFromIdx === null || dragFromIdx === toIdx) return;
        const [moved] = items.splice(dragFromIdx, 1);
        items.splice(toIdx, 0, moved);
        items = items.map((it, i) => ({ ...it, order: i }));
        render();
      };
    });
  }

  function addFiles(fileList) {
    for (const file of fileList) {
      if (!file.type.startsWith("image/")) continue;
      items.push({
        file,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
        order: items.length,
        isNew: true,
      });
    }
    render();
  }

  render();

  return {
    getItems: () => items,
    // Call when the form closes (cancelled or saved) to release any
    // preview blob URLs still held for images that were never uploaded
    // (e.g. the user picked files, then cancelled without saving).
    cleanup: () => {
      items.forEach(it => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
    },
    // Uploads any pending (isNew) files to Storage. Returns { images,
    // failedNames } instead of throwing or just returning the array —
    // the caller (product-form.js) needs to know when some photos
    // didn't make it so it can tell the user clearly, rather than
    // showing the same "Product saved" message it would for a fully
    // successful save. A failed upload here previously only got a
    // toast that auto-dismissed in ~2.6s — easy to miss, and the save
    // still reported success right after, which is actively misleading.
    async uploadPendingImages(productId) {
      const failedNames = [];
      for (const it of items) {
        if (it.isNew && it.file) {
          try {
            const uploaded = await uploadProductImage(productId, it.file, it.order);
            // Mutate the item in place (rather than building a separate
            // results array) so that if the user saves again after a
            // partial failure, this succeeded photo isn't re-uploaded —
            // only whatever is still marked isNew gets retried.
            if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
            Object.assign(it, uploaded, { isNew: false, file: undefined, previewUrl: undefined });
          } catch (e) {
            failedNames.push(it.name);
          }
        }
      }
      const images = items
        .filter(it => !(it.isNew && it.file)) // drop whatever is still pending (failed) — don't save a broken reference
        .map((it, i) => {
          const { previewUrl, file, isNew, ...clean } = it;
          return { ...clean, order: i };
        });
      return { images, failedNames };
    },
  };
}
