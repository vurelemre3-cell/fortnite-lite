# fortnite-lite

A stripped-down, playable Fortnite in the browser: battle bus drop, loot, grid
building, shrinking storm, 24 players, last one standing. Zero dependencies —
a custom WebGL2 renderer, CC0 KayKit models, and a plain Node server. Play solo
against bots, or open a lobby and drop in with friends.

## Run locally

```bash
node server.js          # → http://localhost:3500
```

Anyone on your network can join lobbies at `http://<your-ip>:3500`.

## Host it on Railway (play with friends over the internet)

The server is one Node file with no packages to install, so Railway needs
nothing but the repo.

1. Push this repo to GitHub (it lives at `arcedav/fortnite-lite`).
2. In [Railway](https://railway.app): **New Project → Deploy from GitHub repo**
   → pick `fortnite-lite`. Railway sees `package.json`, runs `npm start`
   (`node server.js`) and sets `PORT` itself. Nothing else to configure.
3. **Settings → Networking → Generate Domain**. You get something like
   `https://fortnite-lite-production.up.railway.app`.
4. Open that URL, type a name, **CREATE LOBBY**, and send friends the code (or
   the `?join=CODE` link the lobby panel shows). Everyone joins, the host
   presses **START MATCH**.

`/health` reports open lobbies and player counts. Live reload is automatically
off on Railway (`RAILWAY_ENVIRONMENT`), or set `NODE_ENV=production`.

### Static hosting (GitHub Pages) + Railway

The page also works from any static host — `https://arcedav.github.io/fortnite-lite/`
— but lobbies need the Node server. Point the static page at the Railway
deployment by setting `window.NET_SERVER` in `index.html`:

```html
<script> window.NET_SERVER = 'https://fortnite-lite-production.up.railway.app'; </script>
```

(or open `…/?server=https://your-app.up.railway.app` without editing anything).

## How multiplayer works

The server is only a relay: it hands out 4-letter lobby codes and forwards
messages. The lobby **host's browser runs the match** — bots, storm, loot,
structural collapse and everyone's health — and broadcasts what it decides.
Each player simulates their own movement, aiming, shooting and building locally
so controls feel instant; their pose goes out 20 times a second and other
players are drawn from those poses, interpolated a little behind real time.
Hits, pickups, drops, chests and heals are requests to the host. If the host
leaves, the match ends and the next player becomes host of the lobby. Up to 16
humans per lobby; bots fill the rest of the 24 (or turn them off for humans
only). After you're eliminated you can spectate until the match ends.

## Controls

Keyboard + mouse or a gamepad (Builder Pro) — the full lists are on the title
screen. Sprint is a toggle (Shift / L3). Aiming in (right mouse) nudges the
crosshair onto a nearby enemy; a gamepad gets the fuller console-style assist.

## Tests

```bash
npm test                # collision/building suite + relay server test
node dev/mptest.js      # headless host + client playing a match through an in-memory relay
node dev/browsertest.js # two real headless Chrome pages through the live server (needs Chrome, server running)
```

See `CONTEXT.md` for the design notes and `dev/README.md` for the tooling.
