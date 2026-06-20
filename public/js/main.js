// Entry point: connects, manages screen flow, wires global net + input.
import { Net } from './net.js';
import { UI } from './ui.js';
import { Game } from './game.js';
import { initInput } from './input.js';
import { initTouch } from './touch.js';
import { preloadPlayer } from './assets.js';

const $ = (id) => document.getElementById(id);
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
  ui.onInventory();
  ui.onDevStatus();
  showScreen('worldSelect');
  net.send('getWorlds');
});
net.on('authError', (m) => ui.showAuthError(m.text));
net.on('worldList', (m) => renderWorldList(m.worlds));
net.on('notify', (m) => ui.toast(m.text));
net.on('chat', (m) => ui.addChat(m.name, m.text, false, m.dev));
net.on('profile', (m) => ui.onProfile(m));
net.on('devList', (m) => ui.onDevList(m.developers || []));
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
$('logoutBtn').onclick = () => location.reload();

// ---------- login / accounts ----------
function creds() {
  return { name: $('nameInput').value.trim(), password: $('passInput').value };
}
$('loginBtn').onclick = () => { const c = creds(); if (c.name) sendAuth('login', c); };
$('registerBtn').onclick = () => { const c = creds(); if (c.name) sendAuth('register', c); };
$('guestBtn').onclick = () => { const c = creds(); sendAuth('join', { name: c.name || 'Guest' }); };
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

// ---------- boot ----------
(async function boot() {
  preloadPlayer();
  setAuthButtons(false);
  ui.showAuthError('Connecting to the game server...');
  try {
    await net.connect();
    setAuthButtons(true);
    $('authError').classList.add('hidden');
    $('nameInput').focus();
  } catch {
    setAuthButtons(false);
    ui.showAuthError('Could not connect to the game server. Reload this page or ask for a fresh link.');
  }
})();
