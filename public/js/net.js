// Thin WebSocket wrapper with a type -> handler map.
export class Net {
  constructor() { this.handlers = {}; this.ws = null; }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}`);
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
