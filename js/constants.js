// ============================================================================
// constants.js — single source of truth for enums used across the app.
// Add a size or type here and it shows up everywhere (matrix generator,
// filters, badges) without touching other files.
// ============================================================================

// Sizes are type-specific: shirts use letter sizes, accessories are
// usually one-size. Pants come in both waist-number sizing and
// letter sizing (different styles use different conventions), so both
// sets of sizes are offered for PANTS. Add/change values here and it
// applies everywhere (product form, filters).
export const SIZES_BY_TYPE = {
  SHIRT: ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"],
  PANTS: ["28", "29", "30", "31", "32", "34", "36", "S", "M", "L", "XL", "2XL", "3XL", "4XL"],
  ACCESSORY: ["One Size"],
};

export const VARIANT_TYPES = Object.keys(SIZES_BY_TYPE);

// Every distinct size across all types — used for the top-level search
// filter dropdown, which isn't tied to a single type.
export const SIZES = [...new Set(Object.values(SIZES_BY_TYPE).flat())];

export function sizesForType(type) {
  return SIZES_BY_TYPE[type] || SIZES;
}

export const DEFAULT_CATEGORY_COLOR = "#6b7280";
export const DEFAULT_TAG_COLOR = "#3b82f6";

export function emptyVariant(overrides = {}) {
  return {
    pos_code: "",
    alternate_codes: [],
    type: "SHIRT",
    size: "M",
    color_name: "",
    color_hex: "#000000",
    stock_quantity: 0,
    price: 0,
    status: "STORED", // STORED = in the product's storage location; SHOWN = currently out on the live/showroom floor
    ...overrides,
  };
}

// Which product field holds which location. Staff have always typed the ACTUAL STOCK
// place (e.g. B23) into the field stored as "sample_location", and the sample /
// display place into "storage_location" — so the screens follow the data instead of
// the data being moved: every existing location stays exactly where it was saved.
// Every screen (product card, detail, Edit form, 📍 Locations scans) reads this.
export const LOCATION_FIELDS = {
  stock: "sample_location",   // 📦 Storage location (actual stock) — e.g. B23
  sample: "storage_location", // 👕 Sample location (display piece)
};

// Storage bin suggestions for the Live tab's location field (A1–A14).
// It's a free-text field so any code (including ones outside this list,
// like a second row B1–B14) still works — this just powers autocomplete.
export const STORAGE_LOCATIONS = Array.from({ length: 14 }, (_, i) => `A${i + 1}`);

// Common sample/display spots, offered the same way as storage bins above
// (autocomplete suggestions on an otherwise free-text field) so setting a
// sample location is usually a couple of taps instead of typing it out
// every time. Edit this list to match how the shop actually describes
// where display pieces sit.
export const SAMPLE_LOCATIONS = ["Front Window", "Display Rack", "Showroom Wall", "Counter", "Mannequin"];

// Common Khmer color names, offered as autocomplete suggestions on the
// product form's color-name field (still free-text, so any name — Khmer,
// English, or a custom shade — works fine even if it's not in this list).
export const COLOR_SUGGESTIONS = [
  "ខ្មៅ", "សរ", "ប៊ិច", "បៃតង", "សាច់", "ស្លែ",
  "ប្រាក់", "ប្រផេះ", "ក្រហម", "ឈាមជ្រូក", "មេឃ", "ដី",
];
