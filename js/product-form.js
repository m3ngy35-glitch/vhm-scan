// ============================================================================
// product-form.js — Create/Edit Product modal.
// Composes: category dropdown, multi-select tags, image uploader,
// dynamic variant matrix. Saves via db.js only.
// ============================================================================

import { saveProduct } from "./db.js";
import { badge, toast, escapeHtml } from "./ui-components.js";
import { createImageUploader } from "./image-upload.js";
import { VARIANT_TYPES, sizesForType, COLOR_SUGGESTIONS, STORAGE_LOCATIONS, SAMPLE_LOCATIONS, LOCATION_FIELDS } from "./constants.js";
import { generateVariants, renderVariantTable, readVariantTable } from "./variant-matrix.js";

export function openProductForm({ product, categories, tags, onSaved }) {
  const isEdit = !!product;
  const state = {
    id: product?.id || null,
    master_code: product?.master_code || "",
    name: product?.name || "",
    description: product?.description || "",
    category_id: product?.category_id || (categories[0]?.id ?? ""),
    tag_ids: product?.tag_ids || [],
    storage_location: product?.storage_location || "",
    sample_location: product?.sample_location || "",
    variants: product?.variants ? product.variants.map(v => ({ ...v })) : [],
    pendingColors: [], // colors staged for the next "Generate Variants" click
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal modal-lg">
      <div class="modal-header">
        <h2>${isEdit ? "Edit Product" : "New Product"}</h2>
        <button class="btn-icon modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label>Master Code
            <input id="f-master-code" type="text" value="${escapeHtml(state.master_code)}" placeholder="N500" />
          </label>
          <label>Category
            <select id="f-category">
              ${categories.map(c => `<option value="${c.id}" ${c.id === state.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
              ${state.category_id && !categories.some(c => c.id === state.category_id) ? `<option value="${state.category_id}" selected>(deleted category — keep)</option>` : ""}
            </select>
          </label>
        </div>

        <label>Name
          <input id="f-name" type="text" value="${escapeHtml(state.name)}" placeholder="Classic Oversized Tee" />
        </label>

        <label>Description <span class="muted">(line breaks are kept exactly as typed — e.g. a weight guide, one size per line — and it's searchable)</span>
          <textarea id="f-description" rows="6" placeholder="Fabric, fit, care notes, or a weight guide like:&#10;M :50KG-60KG&#10;L :60KG-70KG&#10;XL :70KG-80KG">${escapeHtml(state.description)}</textarea>
        </label>

        <label>Tags
          <div id="f-tags" class="tag-picker">
            ${tags.map(t => `
              <label class="tag-checkbox">
                <input type="checkbox" value="${t.id}" ${state.tag_ids.includes(t.id) ? "checked" : ""} />
                ${badge(t.name, t.color_code)}
              </label>
            `).join("")}
          </div>
        </label>

        <div class="form-row">
          <!-- labels follow the saved data (see LOCATION_FIELDS in constants.js): actual stock = ${LOCATION_FIELDS.stock} -->
          <label>Storage location <span class="muted">(actual stock)</span>
            <input id="f-loc-stock" type="text" list="f-stock-locations" value="${escapeHtml(state[LOCATION_FIELDS.stock])}" placeholder="e.g. B23" />
            <datalist id="f-stock-locations">
              ${STORAGE_LOCATIONS.map(loc => `<option value="${loc}"></option>`).join("")}
            </datalist>
          </label>
          <label>Sample location <span class="muted">(display piece)</span>
            <input id="f-loc-sample" type="text" list="f-sample-locations" value="${escapeHtml(state[LOCATION_FIELDS.sample])}" placeholder="e.g. Front window" />
            <datalist id="f-sample-locations">
              ${SAMPLE_LOCATIONS.map(loc => `<option value="${loc}"></option>`).join("")}
            </datalist>
          </label>
        </div>

        <label>Images
          <div id="f-images"></div>
        </label>

        <hr/>
        <h3>Variant Matrix</h3>
        <div class="form-row">
          <label>Variant type
            <select id="f-vtype">
              ${VARIANT_TYPES.map(t => `<option value="${t}">${t}</option>`).join("")}
            </select>
          </label>
          <label>Sizes
            <div id="f-sizes" class="checkbox-row">
              ${sizesForType("SHIRT").map(s => `<label><input type="checkbox" value="${s}" /> ${s}</label>`).join("")}
            </div>
          </label>
        </div>
        <label>Colors
          <div id="f-color-list" class="chip-manager-list"></div>
          <div class="form-row">
            <input id="f-color-name" type="text" list="f-color-suggestions" placeholder="ឈ្មោះពណ៌ (e.g. ខៀវ, ខ្មៅ)" style="flex:1" />
            <datalist id="f-color-suggestions">
              ${COLOR_SUGGESTIONS.map(c => `<option value="${escapeHtml(c)}"></option>`).join("")}
            </datalist>
            <input id="f-color-hex" type="color" value="#000000" title="Pick the actual color" />
            <button id="f-color-add" class="btn btn-secondary" type="button">Add Color</button>
          </div>
        </label>
        <button id="f-generate" class="btn btn-secondary">Generate Variants</button>

        <div id="f-variant-table" style="margin-top:12px;">
          ${renderVariantTable(state.variants)}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-close">Cancel</button>
        <button id="f-save" class="btn btn-primary">${isEdit ? "Save Changes" : "Create Product"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const imagesContainer = overlay.querySelector("#f-images");
  const uploader = createImageUploader(imagesContainer, product?.images || []);

  const variantTableEl = overlay.querySelector("#f-variant-table");

  // Any preview blob URLs the uploader is still holding (files picked but
  // never uploaded) must be released whenever this form closes, however
  // it closes — Cancel, the × button, clicking outside, or a successful
  // save — otherwise that memory is never freed for the rest of the tab's
  // lifetime.
  function closeForm() {
    uploader.cleanup();
    overlay.remove();
  }
  overlay.querySelectorAll(".modal-close").forEach(btn => btn.onclick = closeForm);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeForm(); });

  overlay.querySelector("#f-vtype").onchange = () => {
    const type = overlay.querySelector("#f-vtype").value;
    const sizesBox = overlay.querySelector("#f-sizes");
    sizesBox.innerHTML = sizesForType(type).map(s => `<label><input type="checkbox" value="${s}" /> ${s}</label>`).join("");
  };

  const colorListEl = overlay.querySelector("#f-color-list");
  function renderColorList() {
    colorListEl.innerHTML = state.pendingColors.length
      ? state.pendingColors.map((c, i) => `
          <div class="chip-row" data-idx="${i}">
            <span class="swatch" style="background:${c.hex}"></span>
            <span>${escapeHtml(c.name)}</span>
            <button class="btn-icon color-remove" data-idx="${i}" title="Remove">&times;</button>
          </div>
        `).join("")
      : `<p class="muted" style="margin:0;">No colors added yet.</p>`;
    colorListEl.querySelectorAll(".color-remove").forEach(btn => {
      btn.onclick = () => {
        state.pendingColors.splice(+btn.dataset.idx, 1);
        renderColorList();
      };
    });
  }
  renderColorList();

  overlay.querySelector("#f-color-add").onclick = () => {
    const nameInput = overlay.querySelector("#f-color-name");
    const hexInput = overlay.querySelector("#f-color-hex");
    const name = nameInput.value.trim();
    if (!name) {
      toast("Enter a color name first (Khmer or English is fine)", "error");
      return;
    }
    state.pendingColors.push({ name, hex: hexInput.value });
    nameInput.value = "";
    nameInput.focus();
    renderColorList();
  };
  // Enter key in the color name field adds it too, without submitting the form
  overlay.querySelector("#f-color-name").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      overlay.querySelector("#f-color-add").click();
    }
  });

  overlay.querySelector("#f-generate").onclick = () => {
    const type = overlay.querySelector("#f-vtype").value;
    const sizes = [...overlay.querySelectorAll("#f-sizes input:checked")].map(el => el.value);
    const colors = state.pendingColors;
    if (!sizes.length || !colors.length) {
      toast("Pick at least one size and add at least one color first", "error");
      return;
    }
    // capture current edits before regenerating
    state.variants = readVariantTable(variantTableEl, state.variants);
    state.variants = generateVariants(state.variants, { type, sizes, colors });
    variantTableEl.innerHTML = renderVariantTable(state.variants);
  };

  variantTableEl.addEventListener("click", e => {
    if (e.target.classList.contains("v-remove")) {
      state.variants = readVariantTable(variantTableEl, state.variants);
      state.variants.splice(+e.target.dataset.idx, 1);
      variantTableEl.innerHTML = renderVariantTable(state.variants);
    }
  });

  overlay.querySelector("#f-save").onclick = async () => {
    const saveBtn = overlay.querySelector("#f-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      const finalVariants = readVariantTable(variantTableEl, state.variants);
      const master_code = overlay.querySelector("#f-master-code").value.trim();
      const name = overlay.querySelector("#f-name").value.trim();
      if (!master_code || !name) {
        toast("Master code and name are required", "error");
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? "Save Changes" : "Create Product";
        return;
      }

      const payload = {
        id: state.id,
        master_code,
        name,
        description: overlay.querySelector("#f-description").value.trim(),
        category_id: overlay.querySelector("#f-category").value,
        // checked tags + any tag this product has that isn't shown (a deleted one), so Restore brings it back
        tag_ids: [...new Set([...overlay.querySelectorAll("#f-tags input:checked")].map(el => el.value)
          .concat(state.tag_ids.filter(id => !tags.some(t => t.id === id))))],
        [LOCATION_FIELDS.stock]: overlay.querySelector("#f-loc-stock").value.trim(),
        [LOCATION_FIELDS.sample]: overlay.querySelector("#f-loc-sample").value.trim(),
        variants: finalVariants,
        images: product?.images || [],
      };

      // Need an id before uploading images (storage path uses it)
      const productId = payload.id || await saveProduct(payload);
      payload.id = productId;
      // Persist it onto state (not just the local payload) — otherwise a
      // retry click after a partial photo-upload failure below would see
      // state.id still null for what's now an existing product, and
      // create a second, duplicate document instead of continuing to
      // update the first one.
      state.id = productId;
      const { images, failedNames } = await uploader.uploadPendingImages(productId);
      payload.images = images;
      await saveProduct(payload);

      if (failedNames.length) {
        // Everything else (name, codes, stock, price...) did save — only
        // the photo(s) didn't. Saying so plainly, and leaving the form
        // open with those photos still in the picker, is what lets the
        // user just hit Save again to retry them, instead of believing
        // (from a generic success message) that the photo made it when
        // it didn't.
        toast(
          `Saved, but ${failedNames.length === 1 ? "this photo" : "these photos"} failed to upload: ${failedNames.join(", ")}. Try Save again to retry ${failedNames.length === 1 ? "it" : "them"}.`,
          "error"
        );
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? "Save Changes" : "Create Product";
        onSaved?.();
        return;
      }

      toast(isEdit ? "Product updated" : "Product created");
      closeForm();
      onSaved?.();
    } catch (err) {
      console.error(err);
      toast("Save failed: " + err.message, "error");
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? "Save Changes" : "Create Product";
    }
  };
}
