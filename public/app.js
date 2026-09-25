/* Magic Garden Tracker - frontend */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const SHOP_LABELS = {
    seed: { label: "Seeds", icon: "🌱" },
    egg: { label: "Eggs", icon: "🥚" },
    tool: { label: "Tools & Potions", icon: "🛠️" },
    decor: { label: "Decor", icon: "🪑" },
    rain: { label: "Rain Shop", icon: "🌧️" },
    dawn: { label: "Dawn Shop", icon: "🌅" },
    amber: { label: "Amber Shop", icon: "🌙" },
    snow: { label: "Snow Shop", icon: "❄️" },
    thunder: { label: "Thunder Shop", icon: "⛈️" },
    apology: { label: "Apology Shop", icon: "🙏" },
  };
  const MAIN_SHOPS = ["seed", "egg", "tool", "decor"];
  const WEATHER_EMOJI = {
    Rain: "🌧️", Frost: "❄️", Snow: "❄️", Thunderstorm: "⛈️",
    Dawn: "🌅", AmberMoon: "🌙", "Amber Moon": "🌙",
  };

  let ME = null; // logged-in user
  let META = null; // { items, weathers }
  let DATA = null; // live shops+weather
  let SUBS = { items: [], weathers: [] };
  let activeShop = "seed";
  let view = "dashboard";
  const timers = new Set();

  // ---------------------------------------------------------------- helpers
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg, isErr = false) {
    const el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.textContent = msg;
    $("toast-wrap").appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function fmtCountdown(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "now";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
    return `${sec}s`;
  }

  const fmtPrice = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
  const fmtInt = (n) => Number(n).toLocaleString("en-US");
  const itemMeta = (itemId) => (META ? META.items[itemId] || null : null);
  const imgTag = (item, cls = "item-img") => {
    const m = itemMeta(item.itemId);
    if (m && m.image) return `<img class="${cls}" src="${m.image}" alt="${escapeHtml(m.name || item.itemId)}" loading="lazy" />`;
    return `<div class="${cls}" style="display:flex;align-items:center;justify-content:center;font-size:2em">📦</div>`;
  };

  // ------------------------------------------------------------ render: userbox
  function renderUserbox() {
    const box = $("userbox");
    if (ME) {
      box.innerHTML = `
        ${ME.avatar ? `<img class="avatar" src="${ME.avatar}" alt="" />` : ""}
        <span class="uname">${escapeHtml(ME.globalName)}</span>
        <a class="btn btn-ghost btn-sm" href="/logout">Log out</a>`;
    } else {
      box.innerHTML = `<button class="btn btn-discord" id="btn-login">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.249.08.08 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.08.08 0 0 0 .031.055 19.9 19.9 0 0 0 5.993 3.03.08.08 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.07.07 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.07.07 0 0 1 .079.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.08.08 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.08.08 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.028ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.42 2.157-2.42 1.21 0 2.176 1.087 2.157 2.42 0 1.335-.956 2.42-2.157 2.42Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.42 2.157-2.42 1.21 0 2.176 1.087 2.157 2.42 0 1.335-.956 2.42-2.157 2.42Z"/></svg>
        Login with Discord</button>`;
      $("btn-login").addEventListener("click", async () => {
        const r = await fetch("/login").then((r) => r.json());
        location.href = r.url;
      });
    }
  }

  // ------------------------------------------------------------ render: weather
  function weatherIconUrl(name, weatherId) {
    if (!META) return null;
    const w = META.weathers[name] || META.weathers[weatherId];
    return w ? w.image : null;
  }

  function renderWeather() {
    const banner = $("weather-banner");
    const cur = DATA.weather && DATA.weather.current;
    const iconEl = $("wb-icon");

    if (cur) {
      banner.classList.add("active");
      const url = weatherIconUrl(cur.name, cur.weatherId);
      iconEl.innerHTML = url ? `<img src="${url}" alt="" />` : "🌤️";
      $("wb-name").textContent = `${cur.name} (${cur.groupId})`;
      $("wb-count").textContent = `ends in ${fmtCountdown(cur.endsAt)}`;
      const subbed = ME && SUBS.weathers.includes(cur.name);
      const btn = $("wb-sub");
      btn.hidden = !ME;
      btn.classList.toggle("on", !!subbed);
      btn.textContent = subbed ? "🔔 Alerting this weather" : "🔔 Alert me for this weather";
      btn.onclick = () => toggleWeatherSub(cur.name);
    } else {
      banner.classList.remove("active");
      iconEl.textContent = "🌤️";
      $("wb-name").textContent = "Clear skies";
      $("wb-count").textContent = "";
      $("wb-sub").hidden = true;
    }

    // upcoming list
    const up = (DATA.weather && DATA.weather.upcoming) || [];
    const list = $("upcoming-list");
    if (!up.length) {
      list.innerHTML = `<span class="muted">Nothing scheduled yet</span>`;
    } else {
      list.innerHTML = up
        .map((w) => {
          const label = w.name || w.groupId;
          const url = w.weatherId ? weatherIconUrl(w.name, w.weatherId) : null;
          const icon = url ? `<img src="${url}" alt="" />` : `<span>${WEATHER_EMOJI[w.groupId] || "❓"}</span>`;
          const secret = w.weatherId ? "" : ` title="Mystery weather - game hasn't revealed it yet"`;
          return `<div class="upcoming-chip"${secret}>${icon}
            <span>${escapeHtml(label)}</span>
            <span class="u-when">in ${fmtCountdown(w.startsAt)}</span></div>`;
        })
        .join("");
    }

    // next restock (min over open main shops)
    let nextAt = null;
    for (const key of MAIN_SHOPS) {
      const s = DATA.shops[key];
      if (s && s.nextRestockAt) {
        if (!nextAt || s.nextRestockAt < nextAt) nextAt = s.nextRestockAt;
      }
    }
    if (nextAt) {
      $("restock-count").textContent = fmtCountdown(nextAt);
      $("restock-at").textContent = new Date(nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } else {
      $("restock-count").textContent = "—";
      $("restock-at").textContent = "";
    }
  }

  // ------------------------------------------------------------ render: shops
  function renderTabs() {
    const tabs = $("shop-tabs");
    const keys = Object.keys(DATA.shops).filter((k) => {
      const s = DATA.shops[k];
      return (s.catalog && s.catalog.length) || (s.items && s.items.length);
    });
    // weather shop closed while we were looking at it -> hop back to seeds
    if (!keys.includes(activeShop)) activeShop = "seed";
    // open shops first, closed weather shops after
    keys.sort((a, b) => {
      const openA = DATA.shops[a].open ? 0 : 1;
      const openB = DATA.shops[b].open ? 0 : 1;
      if (openA !== openB) return openA - openB;
      // keep the main shops in their familiar order before weather ones
      const mainA = MAIN_SHOPS.includes(a) ? 0 : 1;
      const mainB = MAIN_SHOPS.includes(b) ? 0 : 1;
      if (mainA !== mainB) return mainA - mainB;
      return keys.indexOf(a) - keys.indexOf(b);
    });
    tabs.innerHTML = keys
      .map((k) => {
        const info = SHOP_LABELS[k] || { label: k, icon: "🏪" };
        const open = DATA.shops[k].open;
        const shut = !open && !MAIN_SHOPS.includes(k) ? "shut" : "";
        return `<button class="shop-tab ${open ? "open" : ""} ${shut} ${k === activeShop ? "active" : ""}" data-shop="${k}">
          <span class="dot"></span>${info.icon} ${info.label}${shut ? ' <small>closed</small>' : ""}</button>`;
      })
      .join("");
    tabs.querySelectorAll(".shop-tab").forEach((el) =>
      el.addEventListener("click", () => {
        activeShop = el.dataset.shop;
        renderTabs();
        renderShop();
      })
    );
  }

  function renderShop() {
    const grid = $("shop-grid");
    const shop = DATA.shops[activeShop];
    if (!shop) {
      grid.innerHTML = `<div class="muted">Shop data unavailable</div>`;
      return;
    }
    // merge: catalog = everything possible; items = currently stocked
    const stockMap = new Map();
    for (const it of shop.items || []) stockMap.set(it.itemId, it);

    const rows = (shop.catalog || []).map((cat) => {
      const live = stockMap.get(cat.itemId) || cat;
      const stocked = (live.stock ?? 0) > 0;
      const subbed = ME && SUBS.items.includes(cat.itemId);
      const wm = SHOP_LABELS[activeShop] || {};
      const weatherBadge =
        shop.open && !MAIN_SHOPS.includes(activeShop)
          ? `<span class="badge weather-open">${wm.icon || ""} weather shop</span>`
          : "";
      // green/red border tells you what's buyable at a glance
      const stockCls = stocked ? "in-stock" : "out-of-stock";
      return `
        <div class="item-card ${stockCls} ${stocked ? "" : "out"}" data-open="${escapeHtml(cat.itemId)}" title="Click for details & history">
          ${ME ? `<button class="bell ${subbed ? "on" : ""}" data-item="${escapeHtml(cat.itemId)}" title="${subbed ? "Remove alert" : "Alert me when in stock"}">🔔</button>` : ""}
          ${imgTag(cat)}
          <div class="item-name">${escapeHtml(cat.name)}</div>
          <div class="item-price"><span class="coin"></span>${fmtPrice(cat.coinPrice)}</div>
          <div>${stocked ? `<span class="badge in">stock ${live.stock}</span>` : `<span class="badge out">out of stock</span>`}${weatherBadge}</div>
        </div>`;
    });
    grid.innerHTML = rows.join("") || `<div class="muted">This shop has no catalog yet</div>`;

    grid.querySelectorAll(".bell").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation(); // don't open the popup when tapping the bell
        toggleItemSub(b.dataset.item);
      })
    );
    // click anywhere else on the card -> detail popup
    grid.querySelectorAll("[data-open]").forEach((c) =>
      c.addEventListener("click", () => openItemModal(c.dataset.open))
    );

    // saved-copy hint for closed weather shops
    const note = $("shop-note");
    if (note) note.remove();
    if (shop.storedFrom && !shop.open) {
      const div = document.createElement("div");
      div.id = "shop-note";
      div.className = "saved-note";
      div.innerHTML = `📦 Weather's over — this is our saved copy of the ${escapeHtml(
        (SHOP_LABELS[activeShop] || {}).label || activeShop
      )} catalog. Tap 🔔 to get pinged next time it restocks.`;
      grid.before(div);
    }
  }

  // ------------------------------------------------------------ subscriptions
  async function saveSubs() {
    if (!ME) return;
    const r = await fetch("/api/subs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SUBS),
    });
    if (r.ok) {
      const pill = $("alert-count");
      const n = SUBS.items.length + SUBS.weathers.length;
      pill.hidden = n === 0;
      pill.textContent = n;
    }
  }

  async function toggleItemSub(itemId) {
    if (!ME) return toast("Log in first to set alerts", true);
    const i = SUBS.items.indexOf(itemId);
    if (i >= 0) {
      SUBS.items.splice(i, 1);
      toast(`Alert removed: ${itemId}`);
    } else {
      SUBS.items.push(itemId);
      const m = itemMeta(itemId);
      toast(`Alert set: ${m ? m.name : itemId}`);
    }
    await saveSubs();
    renderShop();
    renderAlertsPage();
  }

  async function toggleWeatherSub(name) {
    if (!ME) return toast("Log in first to set alerts", true);
    const i = SUBS.weathers.indexOf(name);
    if (i >= 0) {
      SUBS.weathers.splice(i, 1);
      toast(`Weather alert removed: ${name}`);
    } else {
      SUBS.weathers.push(name);
      toast(`Weather alert set: ${name}`);
    }
    await saveSubs();
    renderWeather();
    renderWeatherPicker();
    renderAlertsPage();
  }

  // ------------------------------------------------------------ alerts page
  function chipHtml(label, img, removable) {
    const x = removable ? `<span class="x" data-remove="1">✕</span>` : "";
    return `<span class="a-chip">${img ? `<img src="${img}" alt="" />` : "🏷️"}${escapeHtml(label)}${x}</span>`;
  }

  // all weathers the game has, as big toggle cards
  const ALL_WEATHERS = [
    { name: "Rain", emoji: "🌧️" },
    { name: "Snow", emoji: "❄️" },
    { name: "Thunderstorm", emoji: "⛈️" },
    { name: "Dawn", emoji: "🌅" },
    { name: "Amber Moon", emoji: "🌙" },
  ];

  function renderWeatherPicker() {
    const el = $("weather-picker");
    if (!el || !META) return;
    el.innerHTML = ALL_WEATHERS.map((w) => {
      const meta = META.weathers[w.name] || {};
      const on = ME && SUBS.weathers.includes(w.name);
      return `<button class="w-card ${on ? "on" : ""}" data-weather="${escapeHtml(w.name)}" title="${on ? "Alert on" : "Alert off"}">
        ${meta.image ? `<img src="${meta.image}" alt="" />` : `<span class="w-emoji">${w.emoji}</span>`}
        <span class="w-name">${escapeHtml(w.name)}</span>
        <span class="w-state">${on ? "🔔 on" : "off"}</span>
      </button>`;
    }).join("");
    el.querySelectorAll("[data-weather]").forEach((btn) =>
      btn.addEventListener("click", () => toggleWeatherSub(btn.dataset.weather))
    );
  }

  function renderAlertsPage() {
    const wi = $("alert-items");
    const ww = $("alert-weathers");
    if (!META) return; // meta not loaded yet; refresh() re-renders after load

    renderWeatherPicker();

    if (!ME) {
      wi.innerHTML = `<span class="a-chip none">Log in to set alerts</span>`;
      ww.innerHTML = `<span class="a-chip none">Log in to set alerts</span>`;
      return;
    }

    wi.innerHTML =
      SUBS.items
        .map((id) => {
          const m = itemMeta(id);
          return chipHtml(m ? m.name : id, m && m.image, true);
        })
        .join("") || `<span class="a-chip none">No item alerts yet — tap 🔔 on any item card</span>`;

    // removal for weathers happens via the picker cards above
    ww.innerHTML =
      SUBS.weathers
        .map((w) => chipHtml(w, (META.weathers[w] || {}).image, false))
        .join("") || `<span class="a-chip none">none yet — tap a weather above</span>`;

    // remove handlers (index-based)
    wi.querySelectorAll("[data-remove]").forEach((el, idx) =>
      el.addEventListener("click", () => toggleItemSub(SUBS.items[idx]))
    );
  }

  // ------------------------------------------------------------ bot status
  function renderBotStatus(bot) {
    const el = $("bot-status");
    const help = $("bot-help");
    const btn = $("btn-test-dm");
    const callout = $("join-callout");
    // hide the "join our server" box once we know they're in the server.
    // (older sessions predating auto-join have no joined flag -> show it)
    if (callout) {
      const inServer = ME && (ME.joined === "member" || ME.joined === "joined");
      callout.hidden = Boolean(inServer);
    }
    const onlineBadge = bot.online ? " · 🟢 online" : " · ⚪ offline";
    if (bot.client_id) {
      $("bot-invite").href = `https://discord.com/oauth2/authorize?client_id=${bot.client_id}&scope=bot&permissions=0`;
    }
    if (bot.configured && bot.ok) {
      el.innerHTML = `<span class="ok">✅ ${escapeHtml(bot.username || "bot")}${onlineBadge}</span>` +
        (ME && (ME.joined === "member" || ME.joined === "joined")
          ? `\n<span class="ok" style="font-size:0.85em">📲 You're in our Discord server — DMs will work.</span>`
          : "");
      help.hidden = true;
      btn.disabled = false;
    } else if (bot.configured) {
      el.innerHTML = `<span class="bad">⚠️ Token set but Discord rejected it: ${escapeHtml(bot.error || "unknown")}</span>`;
      help.hidden = true;
      btn.disabled = true;
    } else {
      el.innerHTML = `<span class="bad">❌ No bot token configured</span>`;
      help.hidden = false;
      btn.disabled = true;
    }
  }

  // ------------------------------------------------------- item detail modal
  function timeAgo(t) {
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function closeModal() {
    const el = $("item-modal");
    if (el) {
      el.classList.remove("open");
      setTimeout(() => el.remove(), 180);
      document.removeEventListener("keydown", modalEscClose);
    }
  }
  function modalEscClose(e) {
    if (e.key === "Escape") closeModal();
  }

  function openItemModal(itemId) {
    closeModal();
    const m = itemMeta(itemId) || {};
    const overlay = document.createElement("div");
    overlay.id = "item-modal";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal card">
        <button class="modal-x" title="Close">✕</button>
        <div class="modal-head">
          ${m.image ? `<img class="modal-img" src="${m.image}" alt="" />` : `<div class="modal-img m-emoji" style="font-size:3em">📦</div>`}
          <div>
            <div class="modal-name">${escapeHtml(m.name || itemId)}</div>
            <div class="modal-type muted">${escapeHtml(m.itemType || "")} · ${escapeHtml((SHOP_LABELS[m.shop] || {}).label || m.shop || "")}</div>
          </div>
        </div>
        <div class="modal-now" id="modal-now">Checking current stock…</div>
        <div class="modal-actions">
          <button class="btn ${SUBS.items.includes(itemId) ? "btn-primary" : "btn-ghost"} modal-bell" id="modal-bell">
            ${SUBS.items.includes(itemId) ? "🔔 Notifications ON" : "🔕 Notify me when in stock"}
          </button>
          <a class="btn btn-ghost" href="https://magicgarden.wiki/wiki/${encodeURIComponent((m.name || itemId).replace(/ /g, "_"))}" target="_blank" rel="noopener">Wiki ↗</a>
        </div>
        <div class="modal-hist">
          <div class="strip-title">🕐 When it was in stock — last 24h</div>
          <div class="muted" id="modal-loading">Loading history…</div>
          <div id="modal-timeline" class="timeline" hidden></div>
          <div id="modal-graph" class="mini-graph"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector(".modal-x").addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener("keydown", modalEscClose);
    requestAnimationFrame(() => overlay.classList.add("open"));

    overlay.querySelector(".modal-bell").addEventListener("click", async (e) => {
      await toggleItemSub(itemId);
      const on = SUBS.items.includes(itemId);
      const b = e.currentTarget;
      b.textContent = on ? "🔔 Notifications ON" : "🔕 Notify me when in stock";
      b.classList.toggle("btn-primary", on);
      b.classList.toggle("btn-ghost", !on);
    });

    loadItemHistory(itemId);
  }

  async function loadItemHistory(itemId) {
    let j;
    try {
      j = await fetch(`/api/history/${encodeURIComponent(itemId)}`).then((r) => r.json());
    } catch {
      const el = $("modal-loading");
      if (el) el.textContent = "Couldn't load history";
      return;
    }
    const now = $("modal-now");
    if (now && j.current) {
      const inStock = (j.current.stock ?? 0) > 0;
      now.innerHTML = inStock
        ? `<span class="badge in">IN STOCK NOW</span> <b>${j.current.stock}×</b> · ${escapeHtml((SHOP_LABELS[j.current.shop] || {}).label || j.current.shop)} · ${fmtPrice(j.current.price)} coins`
        : `<span class="badge out">not in stock right now</span>`;
    } else if (now) {
      now.innerHTML = `<span class="badge out">not in stock right now</span>`;
    }

    const tl = $("modal-timeline");
    const loading = $("modal-loading");
    if (!tl || !loading) return;
    const evs = (j.events || []).slice(0, 50);
    if (!evs.length) {
      loading.textContent = "No restocks recorded yet — we're still watching this item.";
      return;
    }
    loading.hidden = true;
    tl.hidden = false;
    tl.innerHTML = evs
      .map((e) => {
        const clock = new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const shop = e.shop ? ` · ${escapeHtml((SHOP_LABELS[e.shop] || {}).label || e.shop)}` : "";
        return `<div class="tl-item tl-in">
          <span class="tl-dot"></span>
          <span class="tl-label">restocked${e.stock ? ` · ${e.stock}×` : ""}${shop}</span>
          <span class="tl-time" title="${escapeHtml(new Date(e.t).toLocaleString())}">${clock} · ${timeAgo(e.t)}</span>
        </div>`;
      })
      .join("");

    renderRestockStrip($("modal-graph"), evs);
  }

  // 24h restock strip: one glowing tick per recorded restock moment.
  // we only track restocks (not sellouts), so dots on a line are the honest
  // picture - a cluster of ticks = a busy restock wave.
  function renderRestockStrip(box, evs) {
    if (!box) return;
    const now = Date.now();
    const cut = now - 24 * 3600_000;
    const pts = evs.filter((e) => e.t >= cut);
    if (!pts.length) {
      box.innerHTML = `<div class="muted" style="margin:8px 4px 4px">No restocks in the last 24 hours.</div>`;
      return;
    }
    const W = 560, H = 74, PAD = 14;
    const x = (t) => PAD + ((t - cut) / (24 * 3600_000)) * (W - 2 * PAD);
    const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const ticks = pts
      .map((p) => {
        const px = x(p.t).toFixed(1);
        const shop = (SHOP_LABELS[p.shop] || {}).label || p.shop || "";
        const tip = `${escapeHtml(new Date(p.t).toLocaleString())} — in stock ×${p.stock ?? "?"}${shop ? ` · ${escapeHtml(shop)}` : ""}`;
        return `<g class="g-tick"><title>${tip}</title><line x1="${px}" y1="14" x2="${px}" y2="44"/><circle cx="${px}" cy="44" r="4"/></g>`;
      })
      .join("");
    const marks = [];
    for (let h = 24; h >= 0; h -= 6) {
      const t = now - h * 3600_000;
      const px = x(t).toFixed(1);
      marks.push(
        `<line class="g-grid" x1="${px}" y1="8" x2="${px}" y2="52"/>` +
        `<text class="g-lbl" x="${px}" y="68" text-anchor="middle">${h === 0 ? "now" : fmtT(t)}</text>`
      );
    }
    box.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="g-svg">
        ${marks.join("")}
        <line class="g-track" x1="${PAD}" y1="44" x2="${W - PAD}" y2="44"/>
        ${ticks}
      </svg>`;
  }

  let CROPS = null; // crop stat table
  let MUTS = null; // { elemental, visual }
  const calcState = { crop: "Carrot", mutations: new Set() };

  function initCalculator() {
    if (!CROPS || !MUTS) return; // /api/crops not loaded yet; refresh() will call us again
    const cropSel = $("calc-crop");
    if (!cropSel) return;
    if (cropSel.dataset.ready === "1") {
      renderCalcVisual();
      renderMutLegend();
      calc();
      return;
    }
    cropSel.dataset.ready = "1";

    cropSel.innerHTML = Object.values(CROPS)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((c) => `<option value="${c.gameId}">${escapeHtml(c.displayName)} (${c.rarity})</option>`)
      .join("");
    cropSel.value = calcState.crop; // select and preview must agree
    cropSel.addEventListener("change", () => {
      calcState.crop = cropSel.value;
      calcState.mutations.clear();
      renderMutations();
      renderCalcVisual();
      // nothing typed yet? suggest this crop's base weight so there's
      // an immediate, sensible price on screen
      if (!$("calc-size").value) $("calc-size").value = CROPS[calcState.crop].baseWeight;
      calc();
    });

    if (!$("calc-size").value) $("calc-size").value = CROPS[calcState.crop].baseWeight;
    renderMutations();
    renderCalcVisual();
    renderMutLegend();
    $("calc-size").addEventListener("input", calc);
    $("calc-friend").addEventListener("input", calc);
    calc();
  }

  function renderMutations() {
    const wrap = $("calc-mutations");
    const icon = (m) =>
      m.image
        ? `<img src="${m.image}" alt="" />`
        : `<span class="m-emoji">${m.gameId === "Gold" ? "🥇" : "🌈"}</span>`;
    const chip = (m) => {
      const isVisual = !m.group;
      const note = isVisual ? `×${m.mult}` : `+${m.mult - 1}`;
      const on = calcState.mutations.has(m.gameId) ? "on" : "";
      const cls = `mut-chip ${isVisual ? "visual" : ""} ${m.gameId === "Rainbow" ? "rainbow-chip" : ""} ${on}`;
      return `<button class="${cls}" data-mut="${m.gameId}" title="${isVisual ? "replaces other visuals" : "stacks additively"}">
        ${icon(m)} ${escapeHtml(m.displayName)} <small>${note}</small></button>`;
    };
    wrap.innerHTML =
      MUTS.elemental.map(chip).join("") +
      MUTS.visual.map(chip).join("") +
      `<span class="mut-chip both-note">elemental stack · Gold/Rainbow replace</span>`;

    wrap.querySelectorAll("[data-mut]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.mut;
        const isVisual = id === "Gold" || id === "Rainbow";
        if (calcState.mutations.has(id)) {
          calcState.mutations.delete(id);
        } else {
          if (isVisual) {
            calcState.mutations.delete("Gold");
            calcState.mutations.delete("Rainbow");
          }
          calcState.mutations.add(id);
        }
        renderMutations();
        calc();
      });
    });
  }

  // update the crop preview panel (image, rarity color, stats)
  function renderCalcVisual() {
    const c = CROPS[calcState.crop];
    if (!c) return;
    const meta = itemMeta(c.gameId) || {};
    const img = $("cv-img");
    const fb = $("cv-fallback");
    if (meta.image) {
      img.src = meta.image;
      img.hidden = false;
      fb.hidden = true;
    } else {
      img.hidden = true;
      fb.hidden = false;
      fb.textContent = "🌱";
    }
    $("cv-name").textContent = c.displayName;
    const r = c.rarity || "Common";
    const rr = $("cv-rarity");
    rr.textContent = r;
    rr.style.color = RARITY_COLORS[r] || "var(--muted)";
    $("cv-stats").innerHTML =
      `<span>base sell <b>${fmtInt(c.baseSellPrice)}</b></span>` +
      `<span>base weight <b>${c.baseWeight} kg</b></span>` +
      `<span>max scale <b>×${c.maxScale}</b></span>` +
      (c.multiharvest ? `<span>multi-harvest</span>` : "");
  }

  const RARITY_COLORS = {
    Common: "#8f9a91",
    Uncommon: "#7cb342",
    Rare: "#42a5f5",
    Legendary: "#ffa726",
    Mythical: "#ab47bc",
    Divine: "#26c6da",
    Celestial: "#e91e63",
  };

  // small "how it works" legend with the mutation icons
  function renderMutLegend() {
    const el = $("mut-legend");
    if (!el || !MUTS) return;
    const icon = (m) => (m.image ? `<img src="${m.image}" alt="" width="20" height="20" />` : (m.gameId === "Gold" ? "🥇" : "🌈"));
    el.innerHTML =
      MUTS.elemental
        .map((m) => `<span class="a-chip">${icon(m)} ${escapeHtml(m.displayName)} <small>+${m.mult - 1}</small></span>`)
        .join("") +
      MUTS.visual
        .map((m) => `<span class="a-chip">${icon(m)} ${escapeHtml(m.displayName)} <small>×${m.mult}</small></span>`)
        .join("");
  }

  // ---- the game's exact sell-price formula ----
  const SIZE_STEP = 0.05; // game displays weight rounded to this step

  function calcPrice(cropId, displaySize, mutIds, friendPct) {
    const c = CROPS[cropId];
    if (!c || !displaySize || displaySize <= 0) return null;
    let add = 1;
    let visual = 1;
    for (const id of mutIds) {
      const m = [...MUTS.elemental, ...MUTS.visual].find((x) => x.gameId === id);
      if (!m) continue;
      if (id === "Gold" || id === "Rainbow") visual = m.mult;
      else add += m.mult - 1;
    }
    const scale = displaySize / c.baseWeight;
    const lo = Math.round(c.baseSellPrice * (displaySize - SIZE_STEP / 2) / c.baseWeight * add * visual);
    const hi = Math.round(c.baseSellPrice * (displaySize + SIZE_STEP / 2) / c.baseWeight * add * visual);
    const friend = 1 + (friendPct || 0) / 100;
    return {
      lo: Math.floor(lo * friend),
      hi: Math.floor(hi * friend),
      mult: add * visual,
      scale,
    };
  }

  function calc() {
    if (!CROPS || !MUTS) return;
    const size = parseFloat($("calc-size").value);
    const friend = parseFloat($("calc-friend").value) || 0;
    const c = CROPS[calcState.crop];
    const r = calcPrice(calcState.crop, size, calcState.mutations, friend);
    const priceEl = $("cr-price");
    if (!r || !isFinite(r.lo) || !isFinite(r.hi)) {
      $("cr-weight").textContent = "—";
      $("cr-mult").textContent = "×1";
      priceEl.innerHTML = "enter a size";
      return;
    }
    $("cr-weight").textContent = `${(size - SIZE_STEP / 2).toFixed(2)} – ${(size + SIZE_STEP / 2).toFixed(2)} kg`;
    $("cr-mult").textContent = `×${r.mult}`;
    priceEl.innerHTML = r.lo === r.hi
      ? fmtInt(r.lo)
      : `${fmtInt(r.lo)} <small>to</small> ${fmtInt(r.hi)}`;
    // little pop + shine every time the number changes
    priceEl.classList.remove("tick");
    void priceEl.offsetWidth;
    priceEl.classList.add("tick");
    const box = $("calc-result");
    box.classList.remove("flash");
    void box.offsetWidth;
    box.classList.add("flash");
  }

  // ------------------------------------------------------------ theme toggle
  function applyTheme(t) {
    document.body.classList.toggle("dark", t === "dark");
    const btn = $("theme-toggle");
    if (btn) btn.textContent = t === "dark" ? "☀️" : "🌙";
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("mg_theme");
    } catch {}
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(saved || (prefersDark ? "dark" : "light"));
    const btn = $("theme-toggle");
    if (btn) {
      btn.addEventListener("click", () => {
        const next = document.body.classList.contains("dark") ? "light" : "dark";
        applyTheme(next);
        try {
          localStorage.setItem("mg_theme", next);
        } catch {}
      });
    }
  }

  function setView(v) {
    view = v;
    $("view-dashboard").hidden = v !== "dashboard";
    $("view-calc").hidden = v !== "calc";
    $("view-alerts").hidden = v !== "alerts";
    $("nav-dashboard").classList.toggle("active", v === "dashboard");
    $("nav-calc").classList.toggle("active", v === "calc");
    $("nav-alerts").classList.toggle("active", v === "alerts");
    // keep the url in sync so #calc / #alerts links work
    const want = v === "dashboard" ? "" : v;
    if (location.hash !== `#${want}`) history.replaceState(null, "", want ? `#${want}` : location.pathname);
    // little entrance animation on the section we just revealed
    const sec = $(v === "dashboard" ? "view-dashboard" : v === "calc" ? "view-calc" : "view-alerts");
    sec.classList.remove("view-anim");
    void sec.offsetWidth; // restart the animation
    sec.classList.add("view-anim");
    if (v === "calc") initCalculator();
  }

  function renderLoginHero() {
    // only on the dashboard - it would just push the calc/alerts down
    if (view !== "dashboard") {
      const hero = $("login-hero");
      if (hero) hero.remove();
      return;
    }
    const main = document.querySelector("main");
    if (ME) {
      const hero = $("login-hero");
      if (hero) hero.remove();
      return;
    }
    if ($("login-hero")) return;
    const div = document.createElement("div");
    div.id = "login-hero";
    div.className = "login-hero";
    div.innerHTML = `
      <h1>🌱 Welcome to the Garden</h1>
      <p class="muted">Track shops & weather live — get Discord alerts for rare items.</p>
      <ul class="perks">
        <li>🛒 Live stock for Seeds, Eggs, Tools & Decor</li>
        <li>🌦️ Weather shop tracking (Rain, Snow, Thunder, Dawn, Amber Moon)</li>
        <li>🔔 Personal Discord DMs when your items restock</li>
        <li>📲 DMs need our Discord server — <a href="https://discord.gg/WzzkZS8CkB" target="_blank" rel="noopener">join it here</a></li>
      </ul>
      <button class="btn btn-discord" id="btn-login-hero">Login with Discord</button>`;
    main.prepend(div);
    div.querySelector("#btn-login-hero").addEventListener("click", () =>
      $("btn-login").click()
    );
  }

  async function refresh(force = false) {
    try {
      const [data, meta] = await Promise.all([
        fetch("/api/data").then((r) => r.json()),
        META ? Promise.resolve(META) : fetch("/api/meta").then((r) => r.json()),
      ]);
      if (data.error) throw new Error(data.error);
      DATA = data;
      META = meta;
      renderWeather();
      renderTabs();
      renderShop();
      // first meta load (re)paints the alerts page too - it may have been
      // skipped earlier when we navigated straight to #alerts
      renderAlertsPage();
    } catch (e) {
      toast(`Failed to load shop data: ${e.message}`, true);
    }
    // load calculator data once
    if (!CROPS) {
      try {
        const j = await fetch("/api/crops").then((r) => r.json());
        CROPS = j.crops;
        MUTS = j.mutations;
        if (view === "calc") initCalculator();
      } catch {
        /* calculator data unavailable */
      }
    }
  }

  async function refreshMe() {
    try {
      const r = await fetch("/api/me");
      if (r.status === 401) {
        ME = null;
        SUBS = { items: [], weathers: [] };
      } else {
        const j = await r.json();
        ME = j.user;
        SUBS = j.subs || { items: [], weathers: [] };
        renderBotStatus(j.bot || {});
      }
    } catch {
      ME = null;
    }
    renderUserbox();
    renderAlertsPage();
    renderLoginHero();
    const pill = $("alert-count");
    const n = ME ? SUBS.items.length + SUBS.weathers.length : 0;
    pill.hidden = n === 0;
    pill.textContent = n;
  }

  function tickCountdowns() {
    if (!DATA) return;
    // re-render only the time-dependent bits
    const cur = DATA.weather && DATA.weather.current;
    if (cur) $("wb-count").textContent = `ends in ${fmtCountdown(cur.endsAt)}`;
    const up = (DATA.weather && DATA.weather.upcoming) || [];
    document.querySelectorAll(".upcoming-chip .u-when").forEach((el, idx) => {
      if (up[idx]) el.textContent = `in ${fmtCountdown(up[idx].startsAt)}`;
    });
    let nextAt = null;
    for (const key of MAIN_SHOPS) {
      const s = DATA.shops[key];
      if (s && s.nextRestockAt) {
        if (!nextAt || s.nextRestockAt < nextAt) nextAt = s.nextRestockAt;
      }
    }
    if (nextAt) $("restock-count").textContent = fmtCountdown(nextAt);
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    initTheme();
    $("nav-dashboard").addEventListener("click", () => setView("dashboard"));
    $("nav-calc").addEventListener("click", () => setView("calc"));
    $("nav-alerts").addEventListener("click", () => setView("alerts"));
    $("btn-test-dm").addEventListener("click", async () => {
      const btn = $("btn-test-dm");
      btn.disabled = true;
      try {
        const r = await fetch("/api/test-dm", { method: "POST" });
        const j = await r.json();
        if (r.ok && j.ok) toast("Test DM sent! Check Discord.");
        else toast(`Test DM failed: ${j.error || r.status}`, true);
      } catch (e) {
        toast(`Test DM failed: ${e.message}`, true);
      }
      btn.disabled = false;
    });
    // deep links: #calc / #alerts open the right page directly
    // (read the hash BEFORE the first setView, which rewrites the url)
    const initial = location.hash.replace("#", "");
    setView(["calc", "alerts"].includes(initial) ? initial : "dashboard");
    // greeted right after the bot auto-joined them to our server at login
    if (new URLSearchParams(location.search).get("justjoined")) {
      toast("📲 You've been added to our Discord server — notifications enabled!");
      history.replaceState(null, "", "/");
    }
    await refreshMe();
    renderLoginHero();
    await refresh();
    setInterval(tickCountdowns, 1000);
    setInterval(refresh, 15000);
    setInterval(refreshMe, 60000);
  }

  boot();
})();





