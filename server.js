/**
 * server.js - Magic Garden tracker website + Discord notification bot.
 *
 * Zero npm dependencies (Node 20+ built-ins only):
 *   - Proxies https://magicgarden.gg/platform/v1/shops + /weather (with cache)
 *   - Discord OAuth2 login (identify scope) with cookie sessions
 *   - Per-user subscriptions (items + weather) saved to subscriptions.json
 *   - Background poller detects weather starts + item restocks and DMs users
 *     through the configured bot token.
 *
 * Run:  node server.js      (then open http://192.168.1.69:8000)
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// Node 20 only ships WebSocket behind a flag. The Discord gateway needs it,
// so if it's missing just re-launch ourselves with the flag enabled.
// ---------------------------------------------------------------------------
if (typeof WebSocket === "undefined") {
  console.log("[gateway] WebSocket missing - relaunching with --experimental-websocket ...");
  const child = spawn(
    process.execPath,
    ["--experimental-websocket", "--no-warnings", fileURLToPath(import.meta.url)],
    { stdio: "inherit", cwd: __dirname }
  );
  child.on("error", (e) => console.log(`[gateway] respawn failed: ${e.message}`));
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise(() => {}); // the child owns things from here on
}


const CONFIG_PATH = path.join(__dirname, "config.json");
const SUBS_PATH = path.join(__dirname, "subscriptions.json");
const SESSIONS_PATH = path.join(__dirname, "sessions.json");
const META_PATH = path.join(__dirname, "item_meta.json");
const CATALOGS_PATH = path.join(__dirname, "shop_catalogs.json");

const API_BASE = "https://magicgarden.gg/platform/v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DISCORD_API = "https://discord.com/api/v10";
const POLL_MS = 10_000; // poll the game API every 10s
const CACHE_MS = 5_000; // serve cached API data if younger than this

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  client_id: "",
  client_secret: "",
  redirect_uri: "http://192.168.1.69:8000/callback",
  bot_token: "",
  port: 8000,
};

let config = { ...DEFAULT_CONFIG };
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
} catch {
  /* first run - defaults apply */
}
const saveConfig = () =>
  fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));

// ---------------------------------------------------------------------------
// Small JSON persistence helpers
// ---------------------------------------------------------------------------
async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
const saveJson = (file, data) =>
  fsp.writeFile(file, JSON.stringify(data, null, 2));

// ---------------------------------------------------------------------------
// Sessions (cookie token -> { user })
// ---------------------------------------------------------------------------
const SESSION_TTL = 30 * 24 * 60 * 60_000; // 30 days
const sessions = new Map(Object.entries(await loadJson(SESSIONS_PATH, {})));
const persistSessions = () => saveJson(SESSIONS_PATH, Object.fromEntries(sessions));

// pending OAuth states (CSRF tokens): state -> issuedAt
const oauthStates = new Map();

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { user, createdAt: Date.now() });
  persistSessions().catch(() => {});
  return token;
}

function getSessionUser(req) {
  const token = parseCookies(req).mg_session;
  if (!token || !sessions.has(token)) return null;
  const s = sessions.get(token);
  // expired session? drop it and treat as logged out
  if (!s.createdAt || Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    persistSessions().catch(() => {});
    return null;
  }
  return s.user;
}

// ---------------------------------------------------------------------------
// Game API fetching (needs a browser-like User-Agent or the site 403s)
// ---------------------------------------------------------------------------
let apiCache = { at: 0, data: null };

async function fetchGameApi(endpoint) {
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
  return res.json();
}

// does this weather object actually say anything?
function weatherHasData(w) {
  return Boolean(
    w && (w.current || (Array.isArray(w.upcoming) && w.upcoming.length > 0))
  );
}

// The game's /weather endpoint sometimes returns a bare `null` (or the shops
// response momentarily omits its embedded weather) even while a storm is
// active - which used to flip the site to "Clear skies". So: pick whichever
// source has data, and if BOTH come back empty, keep serving the last known
// weather until its window has actually passed.
let lastGoodWeather = null; // { weather, at }

function pickWeather(weather, shopsWeather) {
  const candidates = [weather, shopsWeather].filter(weatherHasData);
  if (candidates.length > 0) {
    // prefer the one with a live current window, else the most upcoming info
    return (
      candidates.find((w) => w.current) ||
      candidates.sort((a, b) => (b.upcoming || []).length - (a.upcoming || []).length)[0]
    );
  }
  // both empty -> reuse the last known weather while it's still meaningful
  if (lastGoodWeather) {
    const lw = lastGoodWeather.weather;
    const now = Date.now();
    const cur = lw.current && new Date(lw.current.endsAt).getTime() > now ? lw.current : null;
    const upcoming = (lw.upcoming || []).filter((u) => new Date(u.endsAt).getTime() > now);
    if (cur || upcoming.length > 0) {
      return { current: cur, upcoming };
    }
  }
  return null;
}

async function getGameData(force = false) {
  if (!force && apiCache.data && Date.now() - apiCache.at < CACHE_MS) {
    return apiCache.data;
  }
  const shops = await fetchGameApi("shops");
  let weather = null;
  try {
    weather = await fetchGameApi("weather");
  } catch {
    weather = null; // shops.weather is the fallback
  }
  const bestWeather = pickWeather(weather, shops.weather);
  if (weatherHasData(bestWeather)) {
    lastGoodWeather = { weather: bestWeather, at: Date.now() };
  }
  const data = {
    shops: shops.shops || {},
    weather: bestWeather || { current: null, upcoming: [] },
    serverTime: new Date().toISOString(),
  };
  apiCache = { at: Date.now(), data };

  rememberCatalogs(data.shops, data.serverTime);
  injectStoredCatalogs(data.shops);

  // Resolve images for any items we haven't seen before (e.g. weather-shop
  // items that only exist while that weather is active). Fire-and-forget;
  // results are cached into item_meta.json and served via /api/meta.
  for (const [shopKey, shop] of Object.entries(data.shops)) {
    const seen = new Set();
    for (const it of [...(shop.items || []), ...(shop.catalog || [])]) {
      if (seen.has(it.itemId)) continue;
      seen.add(it.itemId);
      ensureItemMeta(it.itemId, it.name, shopKey, it.itemType).catch(() => {});
    }
  }

  return data;
}

// Item metadata (name/image/price per itemId) generated by tools/build_item_meta.mjs
const ITEM_META = await loadJson(META_PATH, { items: {}, weathers: {} });
const OVERRIDES = await loadJson(path.join(__dirname, "..", "items.json"), {});
const CROP_DATA = await loadJson(path.join(__dirname, "crop_data.json"), { crops: {} });
const MUTATION_DATA = await loadJson(path.join(__dirname, "mutation_data.json"), {
  elemental: [],
  visual: [],
});

// ---------------------------------------------------------------------------
// Dynamic item-meta resolution: any item the API shows that isn't in meta yet
// gets its wiki image probed and cached (persisted back to item_meta.json).
// ---------------------------------------------------------------------------
const WIKI_CDN = "https://media.magicgarden.wiki";
const toWikiUrl = (name) => `${WIKI_CDN}/${encodeURIComponent(name.replace(/ /g, "_"))}.png`;
const spacedCamel = (id) => id.replace(/([a-z])([A-Z])/g, "$1 $2");

let metaDirty = false;
setInterval(() => {
  if (metaDirty) {
    metaDirty = false;
    saveJson(META_PATH, ITEM_META).catch(() => {});
  }
}, 30_000);

async function wikiExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA } });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function resolveItemImage(itemId, name) {
  // 1) manual overrides from the old bot's items.json (most reliable)
  if (OVERRIDES[name]) return OVERRIDES[name];
  // 2) probe wiki URLs: exact name, suffix-stripped name, spaced itemId
  const stripped = String(name || "").replace(/\s+(Seed|Cutting|Pod|Pit|Kernel|Bean|Fruit)$/i, "");
  const candidates = [...new Set([name, stripped, spacedCamel(itemId)].filter(Boolean))];
  for (const cand of candidates) {
    const url = toWikiUrl(cand);
    if (await wikiExists(url)) return url;
  }
  return null;
}

const resolving = new Set();
async function ensureItemMeta(itemId, name, shop, itemType) {
  if (ITEM_META.items[itemId] || resolving.has(itemId)) return;
  resolving.add(itemId);
  try {
    const image = await resolveItemImage(itemId, name);
    ITEM_META.items[itemId] = {
      itemId,
      name,
      shop: shop || null,
      itemType: itemType || null,
      coinPrice: null,
      image,
      via: "dynamic",
    };
    metaDirty = true;
    console.log(`[meta] resolved ${itemId} (${name}) -> ${image || "no image found"}`);
  } finally {
    resolving.delete(itemId);
  }
}

// ---------------------------------------------------------------------------
// Weather shop memory: the API only returns catalog/items for a weather shop
// WHILE that weather is active. We remember every catalog we've ever seen so
// the site can still list those items (and let you subscribe to them) when
// the shop is closed. shop_catalogs.json: { thunder: { lastSeen, catalog } }
// ---------------------------------------------------------------------------
const knownShops = await loadJson(CATALOGS_PATH, {});
let catsDirty = false;
setInterval(() => {
  if (catsDirty) {
    catsDirty = false;
    saveJson(CATALOGS_PATH, knownShops).catch(() => {});
  }
}, 30_000);

function rememberCatalogs(shops, nowIso) {
  for (const [key, shop] of Object.entries(shops)) {
    if (!shop.catalog || shop.catalog.length === 0) continue;
    const prevById = new Map((knownShops[key] && knownShops[key].catalog || []).map((i) => [i.itemId, i]));
    for (const it of shop.catalog) prevById.set(it.itemId, { ...it }); // fresh wins
    knownShops[key] = { lastSeen: nowIso, catalog: [...prevById.values()] };
    catsDirty = true;
  }
}

function injectStoredCatalogs(shops) {
  for (const [key, shop] of Object.entries(shops)) {
    const known = knownShops[key];
    if ((!shop.catalog || shop.catalog.length === 0) && known && known.catalog && known.catalog.length) {
      // closed weather shop -> show the remembered items, stock zeroed
      shop.catalog = known.catalog.map((i) => ({ ...i, stock: 0 }));
      shop.storedFrom = known.lastSeen;
    }
  }
}

// ---------------------------------------------------------------------------
// Discord bot sender (uses config.bot_token)
// ---------------------------------------------------------------------------
const DM_CACHE = new Map(); // discord user id -> dm channel id
let botStatus = { ok: null, error: null, checkedAt: null, username: null };

async function discordApi(endpoint, options = {}) {
  const res = await fetch(DISCORD_API + endpoint, {
    ...options,
    headers: {
      Authorization: `Bot ${config.bot_token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord API ${endpoint} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json().catch(() => null);
}

// DM flood guard: max messages per user per minute (the poller batches, so a
// legit user gets 1-3; this catches anyone gaming subscriptions).
const DM_LIMIT = 8; // per user per 60s
const dmSent = new Map(); // userId -> [timestamps]

async function sendDm(userId, payload) {
  if (!config.bot_token) return false;
  // flood check
  const now = Date.now();
  const recent = pruneWindow(dmSent.get(userId) || [], now, 60_000);
  if (recent.length >= DM_LIMIT) {
    console.log(`[bot] DM to ${userId} suppressed (rate limit)`);
    dmSent.set(userId, recent);
    return false;
  }
  recent.push(now);
  dmSent.set(userId, recent);

  try {
    let dmChannelId = DM_CACHE.get(userId);
    if (!dmChannelId) {
      const ch = await discordApi(`/users/@me/channels`, {
        method: "POST",
        body: JSON.stringify({ recipient_id: userId }),
      });
      dmChannelId = ch.id;
      DM_CACHE.set(userId, dmChannelId);
    }
    await discordApi(`/channels/${dmChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    botStatus.ok = true;
    botStatus.error = null;
    botStatus.checkedAt = Date.now();
    return true;
  } catch (e) {
    DM_CACHE.delete(userId);
    botStatus.ok = false;
    botStatus.error = String(e.message || e).slice(0, 300);
    botStatus.checkedAt = Date.now();
    console.log(`[bot] DM to ${userId} failed: ${botStatus.error}`);
    return false;
  }
}

async function checkBotToken() {
  if (!config.bot_token) {
    botStatus = { ok: false, error: "no bot token configured", checkedAt: Date.now(), username: null };
    return;
  }
  try {
    const me = await discordApi(`/users/@me`);
    botStatus = { ok: true, error: null, checkedAt: Date.now(), username: me.username };
    startGateway();
  } catch (e) {
    botStatus = { ok: false, error: String(e.message || e).slice(0, 300), checkedAt: Date.now(), username: null };
  }
}

// ---------------------------------------------------------------------------
// Server-membership: DMs only work if the user shares a server with the bot.
// We ask for the guilds.join scope at login, then:
//   1. resolve our guild id (from config or by following the invite code)
//   2. check if the user is already a member
//   3. if not, auto-join them using their fresh OAuth token
// ---------------------------------------------------------------------------
const GUILD_STATE = { id: config.guild_id || null, resolvedAt: 0 };

async function resolveGuildId() {
  if (!config.bot_token) return null;
  if (GUILD_STATE.id && Date.now() - GUILD_STATE.resolvedAt < 10 * 60_000) return GUILD_STATE.id;
  if (config.guild_id) {
    GUILD_STATE.id = config.guild_id;
    GUILD_STATE.resolvedAt = Date.now();
    return GUILD_STATE.id;
  }
  if (!config.invite_code) return null;
  try {
    const res = await fetch(`${DISCORD_API}/invites/${encodeURIComponent(config.invite_code)}`, {
      headers: { Authorization: `Bot ${config.bot_token}` },
    });
    if (res.ok) {
      const inv = await res.json();
      GUILD_STATE.id = inv.guild ? inv.guild.id : null;
      GUILD_STATE.resolvedAt = Date.now();
      if (GUILD_STATE.id) console.log(`[guild] resolved guild ${GUILD_STATE.id} from invite code`);
      return GUILD_STATE.id;
    }
    console.log(`[guild] invite lookup failed: ${res.status} (set "guild_id" in config.json)`);
  } catch (e) {
    console.log(`[guild] invite lookup error: ${e.message}`);
  }
  return null;
}

// member check against our guild (bot token)
async function isMember(guildId, userId) {
  try {
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${config.bot_token}` },
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    console.log(`[guild] member check ${res.status} - assuming not a member`);
    return false;
  } catch {
    return false;
  }
}

// join the user to our guild with their OAuth token (needs guilds.join scope)
async function joinGuild(accessToken, userId) {
  const guildId = await resolveGuildId();
  if (!guildId) return { joined: false, reason: "guild not resolved" };
  try {
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${config.bot_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    // 201 = joined, 204 = already a member, 400/403 = missing scope/bot not in guild
    if (res.status === 201 || res.status === 204) {
      console.log(`[guild] user ${userId} is in the server (auto-join ok)`);
      return { joined: true };
    }
    const body = await res.text().catch(() => "");
    console.log(`[guild] auto-join ${res.status}: ${body.slice(0, 120)}`);
    return { joined: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { joined: false, reason: e.message };
  }
}

// Check + auto-fix membership for a freshly logged-in user. Returns status
// for the UI: "member" | "joined" | "needs_join" | "unknown"
async function ensureMembership(accessToken, userId) {
  const guildId = await resolveGuildId();
  if (!guildId) return "unknown"; // bot token/invite not set up yet
  if (await isMember(guildId, userId)) return "member";
  const r = await joinGuild(accessToken, userId);
  return r.joined ? "joined" : "needs_join";
}

// ---------------------------------------------------------------------------
// Discord gateway: keeps the bot showing as ONLINE (DMs work without this,
const gateway = { ws: null, connected: false, since: null, lastSeq: null, hbTimer: null, delay: 2000 };

function botPublicStatus() {
  return {
    configured: Boolean(config.bot_token),
    ok: botStatus.ok,
    username: botStatus.username,
    error: botStatus.error,
    online: gateway.connected,
    checkedAt: botStatus.checkedAt,
  };
}

async function startGateway() {
  if (typeof WebSocket === "undefined" || !config.bot_token || gateway.ws) return;
  try {
    const info = await discordApi(`/gateway/bot`);
    connectGateway(info.url);
  } catch (e) {
    console.log(`[gateway] fetch failed: ${e.message} - retrying in 30s`);
    setTimeout(startGateway, 30_000);
  }
}

function connectGateway(url) {
  const full = url + (url.includes("?") ? "&" : "?") + "v=10&encoding=json";
  const ws = new WebSocket(full);
  gateway.ws = ws;

  ws.onmessage = (ev) => {
    let p;
    try {
      p = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (p.s != null) gateway.lastSeq = p.s;

    if (p.op === 10) {
      // HELLO -> identify + start heartbeats
      const interval = p.d.heartbeat_interval || 45000;
      gateway.hbTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ op: 1, d: gateway.lastSeq }));
        } catch {}
      }, interval);
      ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token: config.bot_token,
            intents: 0,
            properties: { os: "windows", browser: "magic-garden-tracker", device: "magic-garden-tracker" },
            presence: {
              activities: [{ name: "the garden 🌱", type: 0 }],
              status: "online",
              since: null,
              afk: false,
            },
          },
        })
      );
    } else if (p.op === 0 && p.t === "READY") {
      gateway.connected = true;
      gateway.since = Date.now();
      gateway.delay = 2000;
      console.log(`[gateway] bot is online as ${p.d.user?.username ?? botStatus.username}`);
    } else if (p.op === 7 || p.op === 9) {
      console.log(`[gateway] server asked to reconnect (op ${p.op})`);
      try {
        ws.close();
      } catch {}
    } else if (p.op === 11) {
      // heartbeat ack - all good
    }
  };

  ws.onclose = () => {
    clearInterval(gateway.hbTimer);
    gateway.hbTimer = null;
    gateway.ws = null;
    if (gateway.connected) console.log("[gateway] disconnected - will reconnect");
    gateway.connected = false;
    gateway.since = null;
    if (!config.bot_token) return;
    console.log(`[gateway] reconnecting in ${(gateway.delay / 1000).toFixed(0)}s`);
    setTimeout(() => startGateway(), gateway.delay);
    gateway.delay = Math.min(gateway.delay * 2, 60_000);
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}


// ---------------------------------------------------------------------------
// Notification engine: weather + restock detection, DMs subscribers
// ---------------------------------------------------------------------------
const subs = await loadJson(SUBS_PATH, {}); // discordUserId -> { items: [], weathers: [] }
const saveSubs = () => saveJson(SUBS_PATH, subs);

const lastStockKeys = new Set(); // "itemId|shopKey" in stock at the previous poll
let lastWeatherKey = null; // "weatherId|startsAt" at the previous poll
let pollerStarted = false;

function baseEmbed(title, color, lines) {
  return {
    title,
    color,
    description: lines.join("\n"),
    footer: { text: "Magic Garden Tracker" },
    timestamp: new Date().toISOString(),
  };
}

const relTime = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;

// price of an entry, used to sort restock notifications expensive-first
const priceOf = (meta, entry) => {
  if (entry && entry.coinPrice != null) return entry.coinPrice;
  if (meta && meta.coinPrice != null) return meta.coinPrice;
  return -1; // unknown price sinks to the bottom
};

async function checkNotifications() {
  let data;
  try {
    data = await getGameData(true);
  } catch (e) {
    console.log(`[poller] api error: ${e.message}`);
    return;
  }

  const userIds = Object.keys(subs).filter((uid) => {
    const s = subs[uid] || {};
    return (s.items || []).length > 0 || (s.weathers || []).length > 0;
  });

  // ---- Current in-stock snapshot: itemId -> [{shop, stock, coinPrice}] ----
  const inStockNow = new Map();
  const currentStockKeys = new Set();
  for (const [shopKey, shop] of Object.entries(data.shops)) {
    for (const it of shop.items || []) {
      if ((it.stock ?? 0) > 0) {
        currentStockKeys.add(`${it.itemId}|${shopKey}`);
        if (!inStockNow.has(it.itemId)) inStockNow.set(it.itemId, []);
        inStockNow.get(it.itemId).push({ shop: shopKey, stock: it.stock, coinPrice: it.coinPrice });
      }
    }
  }

  // ---- Weather transition (only when a NEW weather window starts) ----
  const cur = data.weather && data.weather.current;
  const weatherKey = cur ? `${cur.weatherId}|${cur.startsAt}` : null;
  const weatherChanged = cur && weatherKey !== lastWeatherKey;

  for (const uid of userIds) {
    const s = subs[uid] || {};

    // ---------------- Weather notifications ----------------
    if (weatherChanged && (s.weathers || []).length > 0) {
      const matched = s.weathers.find((w) => w === cur.name || w === cur.weatherId);
      if (matched) {
        const wm = ITEM_META.weathers[cur.name] || {};
        const embed = baseEmbed(`\`\`\`${cur.name} weather started!\`\`\``, 0x74b9ff, [
          `**${cur.name}** is active right now.`,
          ``,
          `Ends ${relTime(cur.endsAt)}.`,
        ]);
        if (wm.image) embed.image = { url: wm.image };
        // content carries the mention so the user actually gets pinged
        sendDm(uid, { content: `<@${uid}>`, embeds: [embed] });
      }
    }

    // ---------------- Restock notifications (transitions only) ----------------
    // Collect everything that just came back, across all shops, then send
    // ONE message with the most expensive item first.
    const restocks = [];
    for (const itemId of s.items || []) {
      const entries = inStockNow.get(itemId);
      if (!entries) continue;
      for (const entry of entries) {
        const key = `${itemId}|${entry.shop}`;
        if (lastStockKeys.has(key)) continue; // already in stock last poll -> not news
        const meta = ITEM_META.items[itemId] || {};
        restocks.push({ itemId, meta, entry });
      }
    }
    if (restocks.length === 0) continue;

    // expensive -> cheap
    restocks.sort((a, b) => priceOf(b.meta, b.entry) - priceOf(a.meta, a.entry));

    // one embed per item (embeds can't hold multiple images, so each item
    // gets its own embed with its thumbnail). The mention + a compact
    // "name - stock" list ride along in the message content; only the
    // mention in the FIRST message pings.
    const embeds = restocks.slice(0, 10).map((r, i) => {
      const e = baseEmbed(
        `\`\`\`🛒 ${r.meta.name || r.itemId} in stock!\`\`\``,
        0x2ecc71,
        [
          `Shop: **${r.entry.shop}**`,
          `Stock: **${r.entry.stock}**`,
          r.entry.coinPrice != null ? `Price: **${r.entry.coinPrice.toLocaleString()}** coins` : null,
        ].filter(Boolean)
      );
      if (r.meta.image) e.thumbnail = { url: r.meta.image };
      return e;
    });

    const summary = restocks
      .slice(0, 10)
      .map((r) => `> ${r.meta.name || r.itemId} - ${r.entry.stock}`)
      .join("\n");

    const content = restocks.length > 10
      ? `<@${uid}>\n${summary}\n*(+${restocks.length - 10} more)*`
      : `<@${uid}>\n${summary}`;

    sendDm(uid, { content, embeds });
  }

  // roll snapshots forward
  lastStockKeys.clear();
  for (const k of currentStockKeys) lastStockKeys.add(k);
  if (weatherKey) lastWeatherKey = weatherKey;
}

// ---------------- Poller lifecycle ----------------
function startPoller() {
  if (pollerStarted) return;
  pollerStarted = true;

  // Seed the snapshots with the current state so the bot doesn't spam
  // "in stock!" for things that were already in stock before startup.
  getGameData(true)
    .then((data) => {
      for (const [shopKey, shop] of Object.entries(data.shops)) {
        for (const it of shop.items || []) {
          if ((it.stock ?? 0) > 0) lastStockKeys.add(`${it.itemId}|${shopKey}`);
        }
      }
      const cur = data.weather && data.weather.current;
      if (cur) lastWeatherKey = `${cur.weatherId}|${cur.startsAt}`;
      console.log("[poller] seeded current state");
    })
    .catch(() => {});

  setInterval(() => checkNotifications().catch((e) => console.log(`[poller] ${e.message}`)), POLL_MS);
  console.log(`[poller] started (every ${POLL_MS / 1000}s)`);
}

// ---------------------------------------------------------------------------
// Discord OAuth2 helpers
// ---------------------------------------------------------------------------
async function oauthExchange(code) {
  const body = new URLSearchParams({
    client_id: config.client_id,
    client_secret: config.client_secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirect_uri,
  });
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`token exchange failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchDiscordUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`user fetch failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fsp
    .readFile(filePath)
    .then((data) => {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // never cache the app itself - stale JS/CSS broke the calculator once
        "Cache-Control": "no-cache",
      });
      res.end(data);
    })
    .catch(() => sendJson(res, 404, { error: "not found" }));
}

// ---------------------------------------------------------------------------
// Security: per-IP rate limiting, request caps, abuse tracking.
// A small sliding-window limiter — enough to stop request spam and brute
// forcing without any external deps. Buckets: global, per-IP, per-IP+route.
// ---------------------------------------------------------------------------
const RATE_LIMITS = {
  windowMs: 60_000, // per-minute windows
  global: 2000, // whole server (all IPs)
  ip: 120, // per IP per minute
  api: 40, // per IP on /api/* data endpoints
  auth: 6, // per IP on /login + /callback (OAuth is expensive + Discord-side)
  dm: 1, // test DMs: 1 per user per DM_COOLDOWN
  dmWindowMs: 10 * 60_000, // 10 minutes between test DMs
};

const rateState = {
  global: new Map(), // "all" -> [timestamps]
  ip: new Map(), // ip -> [timestamps]
  api: new Map(), // ip -> [timestamps]
  auth: new Map(), // ip -> [timestamps]
  dm: new Map(), // userId -> [timestamps]
  blocked: new Map(), // ip -> { until, strikes }
};

function pruneWindow(arr, now, ms) {
  while (arr.length && arr[0] <= now - ms) arr.shift();
  return arr;
}

function hitRate(key, map, limit, windowMs) {
  const now = Date.now();
  const arr = pruneWindow(map.get(key) || [], now, windowMs);
  arr.push(now);
  map.set(key, arr);
  return arr.length > limit; // true = over the limit
}

// Periodic cleanup so the maps can't grow forever under an IP-flood.
setInterval(() => {
  const now = Date.now();
  pruneWindow(rateState.global, now, RATE_LIMITS.windowMs * 2);
  for (const [k, v] of rateState.ip) {
    pruneWindow(v, now, RATE_LIMITS.windowMs * 2);
    if (!v.length) rateState.ip.delete(k);
  }
  for (const [k, v] of rateState.api) {
    pruneWindow(v, now, RATE_LIMITS.windowMs * 2);
    if (!v.length) rateState.api.delete(k);
  }
  for (const [k, v] of rateState.auth) {
    pruneWindow(v, now, RATE_LIMITS.windowMs * 2);
    if (!v.length) rateState.auth.delete(k);
  }
  for (const [k, v] of rateState.dm) {
    pruneWindow(v, 5 * 60_000, 5 * 60_000);
    if (!v.length) rateState.dm.delete(k);
  }
}, 60_000).unref();

// ------------------------------------------------------- request body caps
const MAX_BODY = 20_000; // 20KB is far more than any legit request needs

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    let dead = false;
    req.on("data", (c) => {
      raw += c;
      if (raw.length > MAX_BODY) {
        dead = true;
        req.destroy();
        resolve({});
      }
    });
    req.on("end", () => {
      if (dead) return;
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// ------------------------------------------------------- security headers
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // our api only ever serves json from these routes; keep browsers from
  // sniffing anything else into executing
  res.setHeader("Content-Security-Policy", "default-src 'none'");
}

// ---------------------------------------------------------------------------
// HTTP server + routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  // ---- basic request hygiene ----
  securityHeaders(res);
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed" });
  }
  // oversized URLs are never legit here
  if (req.url.length > 2048) {
    return sendJson(res, 414, { error: "uri too long" });
  }
  // the site is served over plain http on a LAN; still don't let proxies
  // cache or script tag the api
  res.setHeader("X-Robots-Tag", "noindex");

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "?";

  // ---- abusive-IP blocklist (repeated offenders get 15 min of silence) ----
  const blocked = rateState.blocked.get(ip);
  if (blocked && blocked.until > Date.now()) {
    return sendJson(res, 429, { error: "slow down" });
  }
  if (blocked && blocked.until <= Date.now()) rateState.blocked.delete(ip);

  // ---- global cap (someone flooding from many IPs) ----
  if (hitRate("all", rateState.global, RATE_LIMITS.global, RATE_LIMITS.windowMs)) {
    return sendJson(res, 429, { error: "server busy" });
  }

  // ---- per-IP cap ----
  const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (hitRate(ip, rateState.ip, RATE_LIMITS.ip, RATE_LIMITS.windowMs)) {
    // loopback (your own machine) gets throttled but never hard-blocked,
    // so you can't lock yourself out while testing
    if (!isLoopback) {
      const strikes = (blocked && blocked.strikes) || 0;
      if (strikes >= 3) {
        rateState.blocked.set(ip, { until: Date.now() + 15 * 60_000, strikes: 0 });
        console.log(`[security] IP ${ip} blocked for 15 min (repeat offender)`);
      } else {
        rateState.blocked.set(ip, { until: 0, strikes: strikes + 1 });
      }
    }
    return sendJson(res, 429, { error: "too many requests" });
  }

  // ---- per-IP caps for sensitive route groups ----
  if (p.startsWith("/api/")) {
    if (hitRate(ip, rateState.api, RATE_LIMITS.api, RATE_LIMITS.windowMs)) {
      return sendJson(res, 429, { error: "too many api requests" });
    }
  }
  if (p === "/login" || p === "/callback") {
    if (hitRate(ip, rateState.auth, RATE_LIMITS.auth, RATE_LIMITS.windowMs)) {
      return sendJson(res, 429, { error: "too many login attempts, wait a minute" });
    }
  }

  try {
    // ---------------- API: live game data (cached proxy) ----------------
    if (p === "/api/data") {
      const data = await getGameData();
      return sendJson(res, 200, data);
    }

    // ---------------- API: item metadata (names + images) ----------------
    if (p === "/api/meta") {
      return sendJson(res, 200, ITEM_META);
    }

    // ---------------- API: crop stats + mutations (calculator) ----------------
    if (p === "/api/crops") {
      return sendJson(res, 200, { crops: CROP_DATA.crops, mutations: MUTATION_DATA });
    }

    // ---------------- API: bot status ----------------
    if (p === "/api/bot-status") {
      return sendJson(res, 200, { ...botPublicStatus(), client_id: config.client_id });
    }

    // ---------------- API: who am I ----------------
    if (p === "/api/me") {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: "not logged in" });
      return sendJson(res, 200, {
        user,
        subs: subs[user.id] || { items: [], weathers: [] },
        bot: botPublicStatus(),
      });
    }

    // ---------------- API: subscriptions (login required) ----------------
    if (p === "/api/subs" && req.method === "POST") {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: "not logged in" });
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items.filter((x) => typeof x === "string").slice(0, 100) : [];
      const weathers = Array.isArray(body.weathers)
        ? body.weathers.filter((x) => typeof x === "string").slice(0, 20)
        : [];
      subs[user.id] = { items, weathers };
      await saveSubs();
      return sendJson(res, 200, { ok: true, subs: subs[user.id] });
    }

    // ---------------- API: test DM (login required, cooldown) ----------------
    if (p === "/api/test-dm" && req.method === "POST") {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: "not logged in" });
      if (!config.bot_token) {
        return sendJson(res, 400, { error: "no bot token configured in website/config.json" });
      }
      // 1 per 10 minutes per user - the real notifications come from the
      // poller anyway; this is just a "does it work" button
      if (hitRate(user.id, rateState.dm, RATE_LIMITS.dm, RATE_LIMITS.dmWindowMs)) {
        return sendJson(res, 429, {
          error: "test DM cooldown - you can send one every 10 minutes",
        });
      }
      const ok = await sendDm(user.id, {
        embeds: [
          baseEmbed("🌱 Test notification", 0x4caf50, [
            "It works! You'll get messages here when your",
            "subscribed items restock or weathers start.",
          ]),
        ],
      });
      return sendJson(res, ok ? 200 : 502, { ok, error: ok ? null : botStatus.error });
    }

    // ---------------- Discord OAuth: start login ----------------
    if (p === "/login") {
      // CSRF token: issued here, must come back on /callback untouched.
      // Also hard-caps the number of pending logins so nobody can make us
      // track millions of states.
      const state = crypto.randomBytes(16).toString("hex");
      oauthStates.set(state, Date.now());
      if (oauthStates.size > 500) {
        // drop the oldest half
        const keys = [...oauthStates.keys()].slice(0, 250);
        for (const k of keys) oauthStates.delete(k);
      }
      const params = new URLSearchParams({
        client_id: config.client_id,
        redirect_uri: config.redirect_uri,
        response_type: "code",
        // guilds.join lets us add the user to our server automatically
        // guilds.members.read lets us check whether they're already in it
        scope: "identify guilds.join guilds.members.read",
        state,
        prompt: "consent",
      });
      return sendJson(res, 200, { url: `https://discord.com/oauth2/authorize?${params}` });
    }

    // ---------------- Discord OAuth: callback ----------------
    if (p === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) {
        return sendJson(res, 400, { error: "missing code", discord: url.searchParams.get("error_description") });
      }
      // CSRF check: the state we generated at /login must come back to us.
      // Expired (10 min) or unknown states are rejected.
      const issuedAt = oauthStates.get(state);
      oauthStates.delete(state); // single-use
      if (!issuedAt || Date.now() - issuedAt > 10 * 60_000) {
        console.log("[security] rejected oauth callback (bad/expired state)");
        return sendJson(res, 400, { error: "login session expired - go back and try again" });
      }
      const token = await oauthExchange(code);
      const discordUser = await fetchDiscordUser(token.access_token);
      const user = {
        id: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.global_name || discordUser.username,
        avatar: discordUser.avatar
          ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=64`
          : null,
        joined: false,
      };
      // try to add them to our server right away (guilds.join scope).
      // if they're already a member this is instant; if they decline to
      // join, the site shows the join callout instead.
      try {
        user.joined = await ensureMembership(token.access_token, user.id);
      } catch (e) {
        console.log(`[guild] membership check failed: ${e.message}`);
        user.joined = "unknown";
      }
      const sessionToken = createSession(user);
      res.setHeader(
        "Set-Cookie",
        `mg_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
      );
      const showJoinedToast = user.joined === "joined" ? "?justjoined=1" : "";
      res.writeHead(302, { Location: `/${showJoinedToast}` });
      return res.end();
    }

    // ---------------- logout ----------------
    if (p === "/logout") {
      const token = parseCookies(req).mg_session;
      if (token) {
        sessions.delete(token);
        persistSessions().catch(() => {});
      }
      res.setHeader("Set-Cookie", "mg_session=; Path=/; HttpOnly; Max-Age=0");
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    // ---------------- static files ----------------
    if (req.method === "GET") {
      let file = p === "/" ? "/index.html" : p;
      file = path.normalize(file).replace(/^([.][.][\\/])+/, "");
      const full = path.join(PUB, file);
      if (full.startsWith(PUB)) return sendFile(res, full);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.log(`[http] ${p} -> ${e.message}`);
    return sendJson(res, 500, { error: e.message });
  }
});

const PORT = Number(config.port) || 8000;
// kill slow/rogue connections so a flood can't tie up sockets
server.headersTimeout = 10_000; // time to receive headers
server.requestTimeout = 30_000; // time to receive the whole request
server.keepAliveTimeout = 15_000;
server.maxRequestsPerSocket = 200; // force reconnects, spreads the load
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Magic Garden tracker running at http://192.168.1.69:${PORT}`);
  console.log(`Redirect URI configured: ${config.redirect_uri}`);
  checkBotToken();
  startPoller();
});

// Hot-reload config.json: paste a bot token (or fix the redirect) and it
// applies without restarting the server.
let cfgMtime = 0;
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  fsp
    .stat(CONFIG_PATH)
    .then((st) => {
      if (st.mtimeMs === cfgMtime) return;
      cfgMtime = st.mtimeMs;
      return fsp.readFile(CONFIG_PATH, "utf8").then((raw) => {
        const next = JSON.parse(raw);
        const hadToken = Boolean(config.bot_token);
        const tokenChanged = (next.bot_token || "") !== (config.bot_token || "");
        config = { ...config, ...next };
        console.log("[config] reloaded config.json");
        if (tokenChanged) {
          if (gateway.ws) {
            try {
              gateway.ws.close();
            } catch {}
          }
          checkBotToken();
        }
      });
    })
    .catch(() => {});
});






