import assert from "node:assert/strict";
import { parseGuide, fitRange, WEIGHT_BANDS, rangeFitsBand } from "../js/weight-guide.js";

const guide = parseGuide(`
អាវលើខ្លួន
តម្លៃ 7.70$💰
កូដ E143
ប្រាក់ M L XL 2XL 3XL
ខ្មៅ M L XL 2XL 3XL
គីឡូ
M :50KG-60KG
L :60KG-70KGM
XL：70 kg ~ 80
XXL 80–90KG
កម្ពស់
M: 160-170cm
L: 170-180cm
គីឡូ
3XL → 90—105kg
`);

assert.deepEqual([...guide.madeSizes], ["M", "L", "XL", "2XL", "3XL"]);
assert.deepEqual(guide.weights.get("L"), { min: 60, max: 70 });
assert.deepEqual(guide.weights.get("2XL"), { min: 80, max: 90 });
assert.deepEqual(guide.weights.get("3XL"), { min: 90, max: 105 });
assert.notDeepEqual(guide.weights.get("M"), { min: 160, max: 170 });
assert.equal(guide.weights.has("7.70"), false);

assert.deepEqual(fitRange([
  { size: "M", qty: 0 },
  { size: "L", qty: 2 },
  { size: "XXL", qty: 1 },
], guide), { min: 60, max: 90 });

const mRange = guide.weights.get("M");
assert.deepEqual(WEIGHT_BANDS.filter(b => rangeFitsBand(mRange, b)).map(b => b.label), ["50–60"]);

const noGuess = parseGuide("Soft cotton shirt\naround sixty kilos\nbeautiful black");
assert.equal(noGuess.weights.size, 0);
assert.equal(noGuess.madeSizes.size, 0);

console.log("weight-guide tests passed");
