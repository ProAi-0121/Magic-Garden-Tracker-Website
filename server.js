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
const sessions = new Map(Object.entries(await loadJson(SESSIONS_PATH, {})));
const persistSessions = () => saveJson(SESSIONS_PATH, Object.fromEntries(sessions));

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
  return sessions.get(token).user;
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

async function getGameData(force = false) {
  if (!force && apiCache.data && Date.now() - apiCache.at < CACHE_MS) {
    return apiCache.data;
  }
  const shops = await fetchGameApi("shops");
  let weather = null;
  try {
    weather = await fetchGameApi("weather");
  } catch {
    weather = shops.weather || null; // shops response embeds weather too
  }
  const data = {
    shops: shops.shops || {},
    weather: weather || shops.weather || { current: null, upcoming: [] },
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

async function sendDm(userId, payload) {
  if (!config.bot_token) return false;
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
// Discord gateway: keeps the bot showing as ONLINE (DMs work without this,
// but presence makes it obvious the tracker is alive).
// ---------------------------------------------------------------------------
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
        const embed = baseEmbed(`${cur.name} weather started!`, 0x74b9ff, [
          `**${cur.name}** is active right now.`,
          ``,
          `Ends ${relTime(cur.endsAt)}.`,
        ]);
        if (wm.image) embed.image = { url: wm.image };
        sendDm(uid, { embeds: [embed] });
      }
    }

    // ---------------- Restock notifications (transitions only) ----------------
    for (const itemId of s.items || []) {
      const entries = inStockNow.get(itemId);
      if (!entries) continue;
      for (const entry of entries) {
        const key = `${itemId}|${entry.shop}`;
        if (lastStockKeys.has(key)) continue; // already in stock last poll -> not news
        const meta = ITEM_META.items[itemId] || {};
        const lines = [
          `**${meta.name || itemId}** just came back in stock!`,
          ``,
          `Shop: **${entry.shop}**`,
          `Stock: **${entry.stock}**`,
        ];
        if (entry.coinPrice != null) {
          lines.push(`Price: **${entry.coinPrice.toLocaleString()}** coins`);
        }
        const embed = baseEmbed(`🛒 ${meta.name || itemId} in stock!`, 0x2ecc71, lines);
        if (meta.image) embed.thumbnail = { url: meta.image };
        sendDm(uid, { embeds: [embed] });
      }
    }
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

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP server + routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

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

    // ---------------- API: test DM (login required) ----------------
    if (p === "/api/test-dm" && req.method === "POST") {
      const user = getSessionUser(req);
      if (!user) return sendJson(res, 401, { error: "not logged in" });
      if (!config.bot_token) {
        return sendJson(res, 400, { error: "no bot token configured in website/config.json" });
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
      const params = new URLSearchParams({
        client_id: config.client_id,
        redirect_uri: config.redirect_uri,
        response_type: "code",
        scope: "identify",
        state: crypto.randomBytes(12).toString("hex"),
        prompt: "consent",
      });
      return sendJson(res, 200, { url: `https://discord.com/oauth2/authorize?${params}` });
    }

    // ---------------- Discord OAuth: callback ----------------
    if (p === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return sendJson(res, 400, { error: "missing code", discord: url.searchParams.get("error_description") });
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
      };
      const sessionToken = createSession(user);
      res.setHeader(
        "Set-Cookie",
        `mg_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
      );
      res.writeHead(302, { Location: "/" });
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






