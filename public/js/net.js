// Thin WebSocket wrapper with a type -> handler map.
import { SERVER_URL } from './config.js';

// Decide which server to connect to. The web build talks back to its own host;
// the packaged apps (Capacitor / Tauri) have no host, so they rely on SERVER_URL.
export function resolveServerUrl() {
  // 1) runtime override for testing: ?server=wss://host
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return q;
  } catch { /* location.search may be unavailable in some shells */ }

  // 2) packaged apps (Capacitor / Tauri) serve their pages from a local scheme
  // (e.g. http://localhost), so the page host is NOT the game server — they must
  // use the explicitly configured SERVER_URL.
  const cap = (typeof window !== 'undefined') ? window.Capacitor : null;
  const isNative = !!((cap && (cap.isNativePlatform ? cap.isNativePlatform() : cap.platform && cap.platform !== 'web'))
    || (typeof window !== 'undefined' && window.__TAURI__));
  if (isNative && SERVER_URL) return SERVER_URL;

  // 3) web build: connect back to whatever host served the page
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  // 4) explicitly configured server (desktop apps loaded from file:// etc.)
  if (SERVER_URL) return SERVER_URL;

  // 5) nothing to connect to
  throw new Error('No game server configured — set SERVER_URL in js/config.js.');
}

export class Net {
  constructor() { this.handlers = {}; this.ws = null; }

  connect() {
    return new Promise((resolve, reject) => {
      let url;
      try { url = resolveServerUrl(); } catch (e) { reject(e); return; }
      this.ws = new WebSocket(url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => { if (this.handlers._close) this.handlers._close(); };
      this.ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        const h = this.handlers[msg.type];
        if (h) h(msg);
      };
    });
  }

  on(type, fn) { this.handlers[type] = fn; return this; }
  isOpen() { return !!(this.ws && this.ws.readyState === WebSocket.OPEN); }
  send(type, payload = {}) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify({ type, ...payload }));
    return true;
  }
}
