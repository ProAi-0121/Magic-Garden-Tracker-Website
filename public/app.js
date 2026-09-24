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
    tabs.innerHTML = keys
      .map((k) => {
        const info = SHOP_LABELS[k] || { label: k, icon: "🏪" };
        const open = DATA.shops[k].open;
        return `<button class="shop-tab ${open ? "open" : ""} ${k === activeShop ? "active" : ""}" data-shop="${k}">
          <span class="dot"></span>${info.icon} ${info.label}</button>`;
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
      return `
        <div class="item-card ${stocked ? "" : "out"}">
          ${ME ? `<button class="bell ${subbed ? "on" : ""}" data-item="${escapeHtml(cat.itemId)}" title="${subbed ? "Remove alert" : "Alert me when in stock"}">🔔</button>` : ""}
          ${imgTag(cat)}
          <div class="item-name">${escapeHtml(cat.name)}</div>
          <div class="item-price"><span class="coin"></span>${fmtPrice(cat.coinPrice)}</div>
          <div>${stocked ? `<span class="badge in">stock ${live.stock}</span>` : `<span class="badge out">out of stock</span>`}${weatherBadge}</div>
        </div>`;
    });
    grid.innerHTML = rows.join("") || `<div class="muted">This shop has no catalog yet</div>`;

    grid.querySelectorAll(".bell").forEach((b) =>
      b.addEventListener("click", () => toggleItemSub(b.dataset.item))
    );
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
    renderAlertsPage();
  }

  // ------------------------------------------------------------ alerts page
  function chipHtml(label, img, removable) {
    const x = removable ? `<span class="x" data-remove="1">✕</span>` : "";
    return `<span class="a-chip">${img ? `<img src="${img}" alt="" />` : "🏷️"}${escapeHtml(label)}${x}</span>`;
  }

  function renderAlertsPage() {
    const wi = $("alert-items");
    const ww = $("alert-weathers");
    if (!META) return; // meta not loaded yet; refresh() re-renders after load

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

    ww.innerHTML =
      SUBS.weathers
        .map((w) => chipHtml(w, (META.weathers[w] || {}).image, true))
        .join("") || `<span class="a-chip none">No weather alerts yet — use the weather banner</span>`;

    // remove handlers (index-based)
    wi.querySelectorAll("[data-remove]").forEach((el, idx) =>
      el.addEventListener("click", () => toggleItemSub(SUBS.items[idx]))
    );
    ww.querySelectorAll("[data-remove]").forEach((el, idx) =>
      el.addEventListener("click", () => toggleWeatherSub(SUBS.weathers[idx]))
    );
  }

  // ------------------------------------------------------------ bot status
  function renderBotStatus(bot) {
    const el = $("bot-status");
    const help = $("bot-help");
    const btn = $("btn-test-dm");
    const onlineBadge = bot.online ? " · 🟢 online" : " · ⚪ offline";
    if (bot.client_id) {
      $("bot-invite").href = `https://discord.com/oauth2/authorize?client_id=${bot.client_id}&scope=bot&permissions=0`;
    }
    if (bot.configured && bot.ok) {
      el.innerHTML = `<span class="ok">✅ ${escapeHtml(bot.username || "bot")}${onlineBadge}</span>`;
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

  // ------------------------------------------------------------ calculator
  let CROPS = null; // crop stat table
  let MUTS = null; // { elemental, visual }
  const calcState = { crop: "Carrot", mutations: new Set() };

  function initCalculator() {
    if (!CROPS || !MUTS) return; // /api/crops not loaded yet; refresh() will call us again
    const cropSel = $("calc-crop");
    if (!cropSel) return;
    if (cropSel.dataset.ready === "1") return;
    cropSel.dataset.ready = "1";

    cropSel.innerHTML = Object.values(CROPS)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((c) => `<option value="${c.gameId}">${escapeHtml(c.displayName)} (${c.rarity})</option>`)
      .join("");
    cropSel.addEventListener("change", () => {
      calcState.crop = cropSel.value;
      calcState.mutations.clear();
      renderMutations();
      calc();
    });

    renderMutations();
    $("calc-size").addEventListener("input", calc);
    $("calc-friend").addEventListener("input", calc);
    calc();
  }

  function renderMutations() {
    const wrap = $("calc-mutations");
    const chip = (m) => {
      const isVisual = !m.group;
      const note = isVisual ? `×${m.mult}` : `+${m.mult - 1}`;
      const on = calcState.mutations.has(m.gameId) ? "on" : "";
      return `<button class="mut-chip ${isVisual ? "visual" : ""} ${on}" data-mut="${m.gameId}" title="${isVisual ? "replaces other visual" : "stacks additively"}">
        ${escapeHtml(m.displayName)} <small>${note}</small></button>`;
    };
    wrap.innerHTML =
      MUTS.elemental.map(chip).join("") +
      MUTS.visual.map(chip).join("") +
      `<span class="mut-chip both-note">elemental stack, Gold/Rainbow replace</span>`;

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
    if (!r || !isFinite(r.lo) || !isFinite(r.hi)) {
      $("cr-weight").textContent = "—";
      $("cr-mult").textContent = "×1";
      $("cr-price").innerHTML = "enter a size";
      return;
    }
    $("cr-weight").textContent = `${(size - SIZE_STEP / 2).toFixed(2)} – ${(size + SIZE_STEP / 2).toFixed(2)} kg`;
    $("cr-mult").textContent = `×${r.mult}`;
    $("cr-price").innerHTML = r.lo === r.hi
      ? r.lo.toLocaleString()
      : `${r.lo.toLocaleString()} <small>to</small> ${r.hi.toLocaleString()}`;
  }

  function setView(v) {
    view = v;
    $("view-dashboard").hidden = v !== "dashboard";
    $("view-calc").hidden = v !== "calc";
    $("view-alerts").hidden = v !== "alerts";
    $("nav-dashboard").classList.toggle("active", v === "dashboard");
    $("nav-calc").classList.toggle("active", v === "calc");
    $("nav-alerts").classList.toggle("active", v === "alerts");
    if (v === "calc") initCalculator();
  }

  function renderLoginHero() {
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
    setView("dashboard");
    await refreshMe();
    renderLoginHero();
    await refresh();
    setInterval(tickCountdowns, 1000);
    setInterval(refresh, 15000);
    setInterval(refreshMe, 60000);
  }

  boot();
})();





