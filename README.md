# 🌱 Growtopia Clone

A 2D MMO sandbox game inspired by **Growtopia** — build, mine, farm, lock worlds, and
trade with other players in real time. Pure JavaScript: a Node WebSocket server and an
HTML5 Canvas client (no build step, no frameworks).

## Run it

```bash
npm install      # installs the only dependency: ws
npm start        # starts the server on http://localhost:3000
```

Open **http://localhost:3000** in your browser. To play multiplayer, open a second tab
or another machine on your network and enter the **same world name**. Logging in with the
same player name on another tab reuses your saved gems & inventory.

## 24/7 hosting

This repo includes `render.yaml` for a Render Web Service named `treetopia`.

Use a paid Render web service with the included persistent disk. Free web services spin
down and do not preserve local filesystem data, which is not suitable for this game.

1. Push changes to `main` on GitHub.
2. In Render, create a new Blueprint from `XtremeFire02/TreeTopia`.
3. Confirm the service uses `render.yaml`.
4. Keep the persistent disk mounted at `/var/data`.
5. Share the permanent `https://treetopia.onrender.com` URL, or attach your own domain.

Every push to `main` deploys the latest code automatically. Runtime account/profile/world
data is written to `DATA_DIR` (`/var/data` on Render), not to the Git repository.

## AWS hosting

This repo also includes an AWS EC2 deploy path in `deploy/aws/`.

Use AWS if you want direct control over a 24/7 server with a permanent Elastic IP.
Follow `deploy/aws/README.md` to create the EC2 instance, bootstrap Node/Nginx/systemd,
and connect GitHub Actions so every push to `main` updates the live game.

## Controls

| Action | Keys |
| --- | --- |
| Move | `←` `→` or `A` `D` |
| Jump (double-jump with Angel Wings) | `↑` `W` or `Space` |
| Punch / break block | Left-click (hold to keep breaking) |
| Place / plant selected item | Right-click |
| Place into background layer | Hold `Shift` + right-click |
| Select hotbar slot | `1`–`9` |
| Open inventory | Drag the **notch ▲** up (or press `E`) |
| Inspect a player | Select the 🔧 **Wrench**, then click the wrench over a player |
| Respawn (death animation) | `R` |
| Chat | `Enter` |

## Features

- **World selection screen** — create or join any named world. Each new world is a flat
  dirt world with a grass surface, a bedrock floor, and a **white door** that spawns at a
  random spot along the top layer. You always spawn in front of it.
- **Mining & drops** — every block takes several hits to break and, on the **Inclusive OR**
  drop table, can yield the **block back**, a **seed**, and/or **gems**. Drops appear as a
  **floating icon at the broken block's position** and are auto-collected when you walk over them.
- **Death & respawn** — touch **lava** (or press `R`) to die: a death animation plays, then
  you respawn back at the white door.
- **Shop** — spend gems on locks, seeds, and decorations.
- **Locks** — **World Lock** (claims a whole world), **Small Lock** and **Huge Lock** (claim
  an area). Only the owner and the **admins** they appoint can build inside. Buy them in the shop.
- **Farming, trees & splicing** — plant a seed → it grows into a tree → punch (break) the
  mature tree to harvest **seeds and/or blocks**. **Splice** two different seeds in the
  inventory screen to discover new block types.
- **Trading** — request a trade with any player in your world, offer items + gems, and both
  sides confirm to swap. Fully validated server-side.
- **Real-time multiplayer** — see other players move, build, and chat live. Worlds and
  player profiles persist to disk under `server/data/`.

## v2 additions

- **Accounts** — register with a username + password (scrypt-hashed, stored in
  `server/data/accounts.json`), or play as a guest. Your gems, items and achievements persist.
- **~900 real sprites** — every sprite from the Kenney CC0 pack is implemented as a
  placeable / breakable / buyable item, rendered with its art. The shop has search + category
  filters to browse them all.
- **Drag-up inventory** — a bottom drawer with a notch handle; drag it up to reveal your full
  inventory (the hotbar stays docked at the bottom).
- **Permanent tools** — the **Fist** ✊ (punch) and **Wrench** 🔧 can never be removed or traded.
- **Wrench → player profiles** — select the wrench and a 🔧 appears beside each player; click it
  to see their **achievements**, **worlds owned** (where they placed a World Lock), **active
  effects**, and to send a trade request.
- **Effects** — **Angel Wings** grant a mid-air **double jump**; the **Cyclopean Visor** grants
  **long punch** (extra reach). Both are buyable and reflected in your profile.
- **Punching animation** — your character throws a fist when you break (visible to others too).
- **Tree timers** — stand on a growing tree to see a countdown bubble of the time left to mature.
- **Hazards** — lava (and spikes) kill you, triggering the death + respawn animation.

## Credits

Art: **Kenney** — "Platformer Art Complete Pack", licensed **CC0 1.0 (public domain)**.
See `public/assets/LICENSE-kenney.txt`. Support the artist at https://kenney.nl.

## Splicing recipes (discover more in-game!)

| Seed A | + Seed B | → Result |
| --- | --- | --- |
| Dirt | Rock | Brick |
| Sand | Lava | Glass |
| Wood | Grass | Leaves |
| Rock | Lava | Gold (rare) |
| Dirt | Grass | Sand |
| Grass | Rock | Wood |

## Project layout

```
server/
  server.js     HTTP static server + WebSocket multiplayer + all game rules
  world.js      World model: generation, tiles, lock permissions, trees, persistence
  data/         Saved worlds & player profiles (created at runtime)
public/
  index.html    Screens: login, world select, in-game HUD & modals
  css/style.css
  js/
    main.js     Entry point + screen flow
    net.js      WebSocket wrapper
    input.js    Keyboard / mouse
    game.js     Game loop, physics, rendering
    ui.js       Hotbar, inventory, shop, trade, chat, etc.
    shared/     constants.js + items.js (used by BOTH client and server)
tools/
  smoketest.mjs End-to-end protocol test (run the server, then `node tools/smoketest.mjs`)
```
