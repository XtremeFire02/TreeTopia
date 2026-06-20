// How TreeTopia finds its multiplayer server in each way it can run.
//
//   • Web build (served by your own Node server): leave SERVER_URL empty. The
//     game connects back to whatever host served the page — no change needed.
//
//   • App builds (iOS / Android via Capacitor, desktop via Tauri): the page is
//     loaded from INSIDE the app, so there is no web host to fall back to. Set
//     SERVER_URL to your live game server so the apps know where to connect:
//
//         export const SERVER_URL = 'wss://treetopia.onrender.com';
//         // or your AWS box:  'wss://your-domain-or-elastic-ip';
//
//     Use wss:// (TLS) for store-shipped apps — iOS and Android block plain ws://
//     by default. ws:// is fine only for local testing.
//
// For quick testing you can also override at runtime with ?server=wss://host in
// the page URL, which beats everything below.
export const SERVER_URL = 'ws://13.237.239.15';
