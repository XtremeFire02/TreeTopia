# Building TreeTopia as iOS, Android & Desktop apps

TreeTopia is one web game (`public/`) wrapped in three native shells:

| Platform | Wrapper | Built with |
| --- | --- | --- |
| iOS / Android | **Capacitor** | Xcode (Mac) / Android Studio |
| Windows / macOS / Linux | **Tauri** | Rust toolchain |

All three load the **same** HTML/Canvas client and connect over WebSocket to your
existing server on AWS. The apps are just a window around the game — there is no
second copy of the game logic to maintain.

> **Why this doesn't change scalability.** Packaging is a *client* concern; how
> many players you can serve is decided entirely by the **server**. These apps
> talk to the same Node process you run today. Scaling that out (shared
> datastore, multiple instances) is a separate effort — see the last section.

---

## 1. One required setting: point the apps at your server

The web version (served by your own Node server) connects back to whatever host
served the page, so it needs no configuration. **The packaged apps have no host
to fall back to**, so you must tell them where the server lives.

Edit **`public/js/config.js`**:

```js
export const SERVER_URL = 'wss://your-domain-or-elastic-ip';
```

- Use **`wss://`** (TLS), not `ws://`. iOS and Android block plaintext sockets in
  shipped apps, so your AWS server needs HTTPS/WSS (a domain + certificate, or a
  TLS-terminating load balancer / Nginx in front of it — the `deploy/aws/` setup
  already runs Nginx, which can terminate TLS).
- Leave it **empty** for the plain web build — that keeps the browser version
  working exactly as before.
- For quick testing you can override at runtime with `?server=wss://host` in the
  page URL.

Re-run `npx cap sync` (mobile) or rebuild (desktop) after changing it.

---

## 2. iOS (requires a Mac with Xcode)

iOS apps can only be built on macOS. From a Mac with Xcode 16+ and CocoaPods:

```bash
npm install
npm run app:add:ios       # creates the ios/ project (first time only)
npm run app:ios           # cap sync + open Xcode
```

In Xcode: pick your Team (Apple Developer account) under *Signing & Capabilities*,
choose a device/simulator, and press Run. For the App Store, *Product → Archive*.

The bundle id is `com.treetopia.game` (set in `capacitor.config.json`); change it
if you already use that identifier.

---

## 3. Android (requires Android Studio / SDK)

On any OS with Android Studio (JDK 21, Android SDK):

```bash
npm install
npm run app:add:android   # creates the android/ project (first time only)
npm run app:android       # cap sync + open Android Studio
```

In Android Studio press Run for a device/emulator. For Play Store, *Build →
Generate Signed Bundle / APK* (produces an `.aab`).

---

## 4. Desktop — Windows, macOS, Linux (Tauri)

Prerequisites:

- **Rust** via <https://rustup.rs>.
- **Linux** also needs the WebView libraries, e.g. on Ubuntu:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **Windows**: WebView2 (preinstalled on Windows 10/11) + MSVC build tools.
- **macOS**: Xcode command line tools (`xcode-select --install`).

Then:

```bash
npm install
npm run desktop:dev       # dev: launches the local Node server + an app window
npm run desktop:build     # produces installers under src-tauri/target/release/bundle/
```

`desktop:dev` loads `http://localhost:3000` (your local server) for live testing.
`desktop:build` bundles `public/` into the app, so the **built** desktop app uses
`SERVER_URL` from `config.js` — set it before building a release.

Output installers: `.msi`/`.exe` (Windows), `.dmg`/`.app` (macOS), `.deb`/
`.AppImage` (Linux), under `src-tauri/target/release/bundle/`.

Icons live in `src-tauri/icons/` (Tauri placeholders for now). Replace them with
your own art via `npx tauri icon path/to/icon-1024.png`.

---

## 5. Updating the apps after you change the game

Because every shell wraps `public/`, the loop is:

1. Edit the game in `public/` as usual.
2. **Mobile:** `npm run app:sync` (copies the new web assets into iOS/Android),
   then rebuild in Xcode / Android Studio.
3. **Desktop:** `npm run desktop:build`.
4. The **web** version updates the moment you deploy `public/` to your server —
   no rebuild needed.

The generated `ios/`, `android/`, and `src-tauri/target/` folders are
git-ignored; they're recreated from this config with the commands above.

---

## 6. When you do need to scale the server

The current server keeps all world/player state **in memory in a single Node
process** and persists to **local JSON files** (`server/data/`). That's fine for
a modest concurrent player count, but it can't run as multiple instances. When
you outgrow one box, the path is roughly:

1. Move persistence off local disk into a shared store (Postgres or DynamoDB for
   accounts/profiles/worlds).
2. Move live, in-memory world state into a shared cache (Redis), and add a
   pub/sub channel so multiple server instances can broadcast to each other.
3. Put the instances behind a load balancer with **sticky sessions** (WebSocket
   connections must stay pinned to one instance), ideally **sharding by world**
   so each world lives on one instance.

None of this affects the apps above — they keep connecting to the same
`SERVER_URL`.
