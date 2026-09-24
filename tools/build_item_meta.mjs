// build_item_meta.mjs - one-time generator.
// Fetches the shops API, then for every catalog item figures out the correct
// wiki image URL by testing candidates against https://media.magicgarden.wiki.
// Writes item_meta.json next to server.js.
//
// Run:  node tools/build_item_meta.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const API = "https://magicgarden.gg/platform/v1/shops";
const WIKI = "https://media.magicgarden.wiki";
const OVERRIDES_PATH = path.join(ROOT, "..", "items.json");

// Load the old bot's manual overrides (display-ish name -> full URL).
let OVERRIDES = {};
try {
  OVERRIDES = JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf-8"));
} catch {}

const toWiki = (name) =>
  WIKI + "/" + encodeURIComponent(name.replace(/ /g, "_")) + ".png";

// Strip shop-suffixes from an item name to get the base crop/plant name.
function baseNames(name) {
  const stripped = name.replace(
    /\s+(Seed|Cutting|Pod|Pit|Kernel|Bean|Fruit)$/i,
    ""
  );
  return [...new Set([name, stripped])];
}

// camelCase itemId -> "Orange Tulip"
const spaced = (id) => id.replace(/([a-z])([A-Z])/g, "$1 $2");

async function exists(url) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": UA },
    });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function resolveImage(itemId, name) {
  // 1) manual overrides first (display name or base name)
  for (const cand of baseNames(name)) {
    if (OVERRIDES[cand]) return { url: OVERRIDES[cand], src: "override" };
  }
  // 2) candidate URL list, tested in order
  const candidates = [
    ...baseNames(name),
    spaced(itemId),
    spaced(itemId).replace(/^(Small|Medium|Large)\s+Garden\s+/, "$1 "),
  ];
  const tried = [];
  for (const cand of [...new Set(candidates)]) {
    const url = toWiki(cand);
    tried.push(cand);
    if (await exists(url)) return { url, src: cand };
  }
  return { url: null, tried };
}

const res = await fetch(API, {
  headers: { "User-Agent": UA, Accept: "application/json" },
});
if (!res.ok) {
  console.error("API fetch failed:", res.status);
  process.exit(1);
}
const data = await res.json();

const meta = {};
let found = 0,
  missing = [];

for (const [shopKey, shop] of Object.entries(data.shops)) {
  const items = shop.catalog && shop.catalog.length ? shop.catalog : [];
  for (const it of items) {
    if (meta[it.itemId]) continue;
    const r = await resolveImage(it.itemId, it.name);
    meta[it.itemId] = {
      itemId: it.itemId,
      name: it.name,
      shop: shopKey,
      itemType: it.itemType,
      coinPrice: it.coinPrice,
      image: r.url,
      via: r.src || null,
    };
    if (r.url) found++;
    else missing.push(`${it.itemId} (${it.name}) tried: ${(r.tried || []).join(", ")}`);
    process.stdout.write(`\r${found} resolved...`);
  }
}

// Weather icons (weatherId / name based, with the old bot's overrides).
const WEATHER_META = {};
for (const [id, name, group] of [
  ["Rain", "Rain", "Hydro"],
  ["Frost", "Snow", "Hydro"],
  ["Thunderstorm", "Thunderstorm", "Hydro"],
  ["Dawn", "Dawn", "Dawn"],
  ["AmberMoon", "Amber Moon", "Amber"],
]) {
  const cands = [
    OVERRIDES[name] && { url: OVERRIDES[name], src: "override" },
  ].filter(Boolean);
  let picked = null;
  for (const c of cands) {
    picked = c;
    break;
  }
  if (!picked) {
    for (const cand of [name, id]) {
      const url = toWiki(cand);
      if (await exists(url)) {
        picked = { url, src: cand };
        break;
      }
    }
  }
  WEATHER_META[name] = {
    weatherId: id,
    name,
    groupId: group,
    image: picked ? picked.url : null,
  };
}

await fs.writeFile(
  path.join(ROOT, "item_meta.json"),
  JSON.stringify({ items: meta, weathers: WEATHER_META }, null, 2)
);
console.log(`\nwrote item_meta.json: ${found} items with images, ${missing.length} missing`);
for (const m of missing) console.log("  MISSING:", m);
