# 🌱 Magic Garden Tracker

A little website I made to keep an eye on the Magic Garden shops and weather.
It logs into Discord, shows everything that's in stock, and DMs you when
something you care about shows up.

No more self-bot stuff — it reads the game's own API
(`magicgarden.gg/platform/v1/...`) directly, same data the official site uses.

## What you get

- **Dashboard** — current weather with a countdown, what's coming next, next shop restock, and every shop with live stock numbers and prices. Weather shops (Rain, Snow, Thunder, Dawn, Amber) show up by themselves while that weather is running — and stay browsable after it ends (saved copy, ready for bell alerts).
- **🔔 Alerts** — tap the bell on any item and the bot DMs you when it restocks. Same for weather: one tap and you'll know the moment it starts. It only pings on *changes*, so no spam.
- **🧮 Sell Calculator** — pick a crop, type the size, tick your mutations, get the sell price range. Uses the actual game formula (same math Daserix' calculator uses — credit where it's due, I pulled the numbers from there).
- **Discord login** — normal OAuth, your avatar shows in the corner.

## Running it

You need Node 20 or newer. That's it, no npm install — zero dependencies.

```
cd website
node server.js
```

Then open `http://192.168.1.69:8000` (or whatever IP/port you set).

## Setting up Discord (one time)

Copy `config.example.json` to `config.json` and fill in three things from the
[Discord Developer Portal](https://discord.com/developers/applications):

1. **client_id / client_secret** — from your app's OAuth2 page.
   On that same page, add `http://192.168.1.69:8000/callback` under Redirects.
2. **bot_token** — Bot page → Reset Token. Paste it in, save the file —
   the server picks it up without a restart, and the bot goes 🟢 online.
3. **Invite the bot** — the "My Alerts" page has an invite link. Add it to any
   server you share, then hit "Send me a test DM" to check it works.

If the bot shows 🟢 online on the alerts page, everything is good.

## Files that matter

```
server.js        the whole backend (API proxy, login, poller, bot)
config.json      your secrets - NOT in git
public/          the website itself
item_meta.json   item names + wiki image links
crop_data.json   crop stats for the calculator
tools/           the scripts that generate those two json files
```

`item_meta.json` grows on its own: when the game adds a new item, the server
notices, finds its wiki image, and remembers it. Same idea for weather shops:
`shop_catalogs.json` keeps a copy of every weather-shop catalog we've seen, so
those items stay listed (and alertable) even while the shop is closed.

## Changing IP or port

Edit `config.json` (`port`), and make sure the redirect URI in the Discord
portal matches. That's the usual suspect when login loops back with an error.

## Credits

- Shop/weather data from the game's platform API
- Item images from [magicgarden.wiki](https://magicgarden.wiki)
- Calculator formula and crop stats from
  [Daserix' Magic Garden Calculator](https://daserix.github.io/magic-garden-calculator/)

Not affiliated with Magic Circle Studio. It's a fan tool.
