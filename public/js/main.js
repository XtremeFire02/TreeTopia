// Entry point: connects, manages screen flow, wires global net + input.
import { Net } from './net.js';
import { UI } from './ui.js';
import { Game } from './game.js';
import { initInput } from './input.js';
import { initTouch } from './touch.js';
import { preloadPlayer } from './assets.js';
import { ITEMS } from './shared/items.js';
import { resolveServerUrl } from './net.js';

const $ = (id) => document.getElementById(id);

// Custom items designed in the Sprite Studio live on the server (persistent data
// dir), so we fetch + merge them into the registry before the game renders. The
// HTTP base is derived from the WebSocket server URL so the packaged apps work.
async function loadCustomItems() {
  let base = '';
  try { base = resolveServerUrl().replace(/^ws/, 'http').replace(/\/$/, ''); } catch { base = ''; }
  try {
    const r = await fetch(base + '/api/custom-items');
    if (!r.ok) return;
    const data = await r.json();
    for (const id in data) {
      const def = { ...data[id] };
      for (const k of ['sprite', 'sheet']) {
        if (def[k] && !/^https?:/i.test(def[k])) def[k] = base + (def[k][0] === '/' ? '' : '/') + def[k];
      }
      ITEMS[id] = { ...(ITEMS[id] || {}), ...def };
    }
  } catch { /* offline or none — game still works with built-in items */ }
}
const net = new Net();
const ui = new UI(net);
const game = new Game(net, ui);
ui.setGame(game);

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
}
function setAuthButtons(enabled) {
  for (const id of ['loginBtn', 'registerBtn', 'guestBtn']) $(id).disabled = !enabled;
}
function sendAuth(type, payload) {
  if (!net.send(type, payload)) {
    ui.showAuthError('Still connecting to the game server. Try again in a moment.');
    setAuthButtons(false);
  }
}

// ---------- network events ----------
net.on('welcome', (m) => {
  game.me.id = m.id; game.me.name = m.name; game.me.gems = m.gems; game.me.inventory = m.inventory;
  game.me.dev = !!m.dev; game.me.equipped = m.equipped || {};
  // a freshly-minted guest gets a token to log back into the same account later
  if (m.guestToken) {
    try { localStorage.setItem('tt_guestName', m.name); localStorage.setItem('tt_guestToken', m.guestToken); } catch { /* ignore */ }
  } else if (pendingCreds) {
    saveCreds(pendingCreds);   // remember a real login/register so it auto-fills next time
  }
  pendingCreds = null;
  ui.clearNotifs();          // notifications persist across worlds, clear on (re)login
  ui.onInventory();
  ui.onDevStatus();
  showScreen('worldSelect');
  net.send('getWorlds');
});
net.on('authError', (m) => { pendingCreds = null; ui.showAuthError(m.text); });
net.on('worldList', (m) => renderWorldList(m.worlds));
net.on('notify', (m) => ui.toast(m.text));
net.on('notif', (m) => ui.addNotif(m));
net.on('profile', (m) => ui.onProfile(m));
net.on('devList', (m) => ui.onDevList(m.developers || []));
net.on('kickedFromWorld', (m) => {
  game.stop();
  ui.closeModals();
  ui.toast(m.reason || 'You left the world.');
  showScreen('worldSelect');
  net.send('getWorlds');
});
net.on('gameBanned', (m) => {
  game.stop();
  ui.closeModals();
  showScreen('login');
  ui.showAuthError(m.reason || 'You have been banned from TreeTopia.');
});
net.on('tradeRequest', (m) => ui.onTradeRequest(m.fromId, m.fromName));
net.on('tradeWindow', (m) => ui.onTradeWindow(m));
net.on('tradeDone', () => ui.onTradeDone());
net.on('_close', () => {
  ui.toast('Disconnected from server.');
  if (!$('login').classList.contains('hidden')) {
    setAuthButtons(false);
    ui.showAuthError('Connection lost. Reload this page or ask for a fresh link.');
  }
});

document.addEventListener('enteredWorld', () => showScreen('game'));
document.addEventListener('backToWorlds', () => { showScreen('worldSelect'); net.send('getWorlds'); });

// ---------- world selection ----------
function renderWorldList(worlds) {
  const list = $('worldList'); list.innerHTML = '';
  if (!worlds.length) { list.innerHTML = '<div class="empty-note">No worlds yet — create one above!</div>'; return; }
  for (const w of worlds) {
    const card = document.createElement('div'); card.className = 'world-card';
    card.innerHTML = `<div class="wname">${w.name}</div>
      <div class="wmeta"><span class="dot">●</span> ${w.players} online ${w.owner ? '· 🔒 ' + w.owner : '· public'}</div>`;
    card.onclick = () => enterWorld(w.name);
    if (game.me.dev) {                          // developers can delete any world
      const del = document.createElement('button');
      del.className = 'world-del'; del.textContent = '🗑️'; del.title = 'Delete world (developer)';
      del.onclick = (e) => {
        e.stopPropagation();
        if (window.confirm(`Delete world ${w.name}? It will be wiped and everyone inside sent out.`)) {
          net.send('deleteWorld', { name: w.name });
        }
      };
      card.appendChild(del);
    }
    list.appendChild(card);
  }
}
function enterWorld(name) {
  name = (name || '').trim().toUpperCase();
  if (!name) return;
  net.send('enterWorld', { name });
}
$('enterWorldBtn').onclick = () => enterWorld($('worldNameInput').value);
$('worldNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') enterWorld($('worldNameInput').value); });
$('refreshWorldsBtn').onclick = () => net.send('getWorlds');
// log out: keep the saved credentials but don't auto-login on the next load,
// so you land back on a PRE-FILLED login screen (one tap, no retyping)
$('logoutBtn').onclick = () => {
  try { sessionStorage.setItem('tt_skipAuto', '1'); } catch { /* ignore */ }
  location.reload();
};

// ---------- login / accounts (with remember-me) ----------
function creds() {
  return { name: $('nameInput').value.trim(), password: $('passInput').value };
}
function saveCreds(c) { try { localStorage.setItem('tt_user', c.name); localStorage.setItem('tt_pass', c.password); } catch { /* ignore */ } }
function loadCreds() { try { return { name: localStorage.getItem('tt_user') || '', password: localStorage.getItem('tt_pass') || '' }; } catch { return { name: '', password: '' }; } }
let pendingCreds = null;   // creds awaiting a 'welcome' to confirm + save
$('loginBtn').onclick = () => { const c = creds(); if (c.name) { pendingCreds = c; sendAuth('login', c); } };
$('registerBtn').onclick = () => { const c = creds(); if (c.name) { pendingCreds = c; sendAuth('register', c); } };
$('guestBtn').onclick = () => {
  // reuse this device's saved guest account if it has one, else mint a new one
  let guestCreds = {};
  try {
    const guestName = localStorage.getItem('tt_guestName');
    const guestToken = localStorage.getItem('tt_guestToken');
    if (guestName && guestToken) guestCreds = { guestName, guestToken };
  } catch { /* localStorage may be unavailable */ }
  sendAuth('join', guestCreds);
};
$('passInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAuth('login', creds()); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('passInput').focus(); });

// ---------- input ----------
initInput(game.canvas, {
  onKey: (k) => {
    if (k >= '1' && k <= '9') return ui.selectSlot(parseInt(k));
    if (k === 'e') return ui.toggleDrawer();
    if (k === 'r') return game.requestRespawn();
    if (k === 'enter') return ui.focusChat();
    if (k === 'escape') ui.closeModals();
  },
  onEscape: () => ui.closeModals(),
});

// on-screen controls for phones / tablets (no-op on desktop)
initTouch(game);

// desktop: scroll wheel to zoom (touch uses pinch)
game.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  game.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

// ---------- boot ----------
(async function boot() {
  preloadPlayer();
  setAuthButtons(false);
  ui.showAuthError('Connecting to the game server...');
  try {
    await net.connect();
    await loadCustomItems();   // merge studio-made items before any UI renders
    setAuthButtons(true);
    $('authError').classList.add('hidden');
    // remember-me: pre-fill saved credentials, and auto-login unless we just
    // logged out (in which case land on the pre-filled login screen)
    const saved = loadCreds();
    if (saved.name) { $('nameInput').value = saved.name; $('passInput').value = saved.password; }
    let skipAuto = false;
    try { skipAuto = sessionStorage.getItem('tt_skipAuto') === '1'; sessionStorage.removeItem('tt_skipAuto'); } catch { /* ignore */ }
    if (saved.name && saved.password && !skipAuto) {
      pendingCreds = saved;
      sendAuth('login', saved);
    } else {
      $('nameInput').focus();
    }
  } catch {
    setAuthButtons(false);
    ui.showAuthError('Could not connect to the game server. Reload this page or ask for a fresh link.');
  }
})();
