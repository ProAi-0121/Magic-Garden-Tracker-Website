// tools/extract_crop_data.mjs - one-time generator.
// Pulls the crop stat table (baseSellPrice, baseWeight, maxScale, rarity,
// growth times) out of Daserix' calculator bundle and writes crop_data.json.
//
// Run:  node tools/extract_crop_data.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const t = fs.readFileSync(path.join(ROOT, "bundle.js"), "utf8");

function evalNum(expr) {
  try {
    return Function(`"use strict";return (${expr});`)();
  } catch {
    return null;
  }
}

// Stage 1: find every `Key:{gameId:"X",displayName:"Y",` entry open.
// Stage 2: parse the stats out of the entry text (up to `baseWeight:`),
// never crossing into the next entry.
const entryRe = /\w+:\{gameId:"(\w+)",displayName:"([^"]+)"/g;
const NUM = "([\\d.*e+]+)"; // handles 4*1e3, 1e7, .1, 45e3 ...
const crops = {};
let m;
while ((m = entryRe.exec(t)) !== null) {
  const window = t.slice(m.index, m.index + 1200);
  const bw = window.match(/baseWeight:([\d.]+)/);
  if (!bw) continue;
  const entry = window.slice(0, bw.index + 40); // only THIS entry's fields

  const num = (re) => {
    const mm = entry.match(re);
    return mm ? evalNum(mm[1]) : null;
  };
  const baseSell = num(new RegExp(`baseSellPrice:${NUM}`));
  const baseWeight = num(/baseWeight:([\d.]+)/);
  if (baseSell === null || baseWeight === null) continue;

  const gameId = m[1];
  if (crops[gameId]) continue;

  crops[gameId] = {
    gameId,
    displayName: m[2],
    multiharvest: /multiharvest:!0/.test(entry),
    slots: num(/slotAmount:(\d+)/) || 1,
    cropGrowthTimeMs: num(new RegExp(`cropGrowthTime:${NUM}`)),
    plantGrowthTimeMs: entry.match(/plantGrowthTime:void 0/) ? null : num(new RegExp(`plantGrowthTime:${NUM}`)),
    seedCoinPrice: num(new RegExp(`seedCoinPrice:(null|${NUM.replace(/^\(|\)$/g, "")})`)),
    baseSellPrice: baseSell,
    maxScale: num(/maxScale:([\d.]+)/) || 1,
    rarity: entry.match(/rarity:"(\w+)"/)?.[1] || "Unknown",
    baseWeight,
  };
}

console.log(`extracted ${Object.keys(crops).length} crops`);

const expected = [
  "Carrot", "Cabbage", "Strawberry", "Aloe", "Beet", "FavaBean", "Blueberry",
  "Apple", "OrangeTulip", "Tomato", "Daffodil", "Corn", "Watermelon",
  "Echeveria", "Pumpkin", "Pear", "Gentian", "Coconut", "Banana", "Lily",
  "Camellia", "Peach", "BurrosTail", "Cactus", "Bamboo", "Chrysanthemum",
  "Grape", "Pepper", "Lemon", "PassionFruit", "DragonFruit", "Cacao",
  "Lychee", "Sunflower", "Starweaver", "PineTree", "Leek", "Squash",
  "Snowdrop", "Poinsettia", "Mushroom", "Ube", "Milkcap", "Habanero",
  "Persimmon", "Date", "Eggplant", "PricklyPear", "Cardoon", "Saffron",
  "Lavender", "Marigold", "Emberbloom", "Embercrown", "Dawnbreaker",
  "Dawnbinder", "Moonbinder", "Clover", "Daisy", "PurpleDaisy",
  "VariegatedCattail", "Cattail", "VioletCort", "Thunderpeel", "Stormcap",
];
const missing = expected.filter((c) => !crops[c]);
console.log(
  "missing from extraction:",
  missing.join(", ") || "none"
);

fs.writeFileSync(
  path.join(ROOT, "crop_data.json"),
  JSON.stringify({ crops }, null, 2)
);
console.log("wrote crop_data.json");

// Mutation table (hand-verified from the bundle's Tt/WC objects).
const mutations = {
  elemental: [
    { gameId: "Wet", displayName: "Wet", mult: 2, group: "Hydro" },
    { gameId: "Chilled", displayName: "Chilled", mult: 2, group: "Hydro" },
    { gameId: "Frozen", displayName: "Frozen", mult: 6, group: "Hydro" },
    { gameId: "Thunderstruck", displayName: "Thunderstruck", mult: 5, group: "Hydro" },
    { gameId: "Thundercharged", displayName: "Thundercharged", mult: 7, group: "Hydro" },
    { gameId: "Dawnlit", displayName: "Dawnlit", mult: 4, group: "Dawn" },
    { gameId: "Ambershine", displayName: "Ambershine", mult: 6, group: "Amber" },
    { gameId: "Dawncharged", displayName: "Dawnbound", mult: 7, group: "Dawn" },
    { gameId: "Ambercharged", displayName: "Amberbound", mult: 10, group: "Amber" },
  ],
  visual: [
    { gameId: "Gold", displayName: "Gold", mult: 25 },
    { gameId: "Rainbow", displayName: "Rainbow", mult: 50 },
  ],
};
fs.writeFileSync(
  path.join(ROOT, "mutation_data.json"),
  JSON.stringify(mutations, null, 2)
);
console.log("wrote mutation_data.json");
