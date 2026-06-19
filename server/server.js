// Growtopia Clone — authoritative game server.
// HTTP static file server + WebSocket multiplayer + persistence.

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { World } from './world.js';
import {
  TILE, REACH, PICKUP_RADIUS, BREAK_RESET_MS, DROP_LIFETIME_MS, RESPAWN_MS, PLAYER_H,
} from '../public/js/shared/constants.js';
import {
  ITEMS, spliceResult, rollDrops, rollHarvest, isSolid,
  PERMANENT, hasEffect, isPlaceable,
} from '../public/js/shared/items.js';

const ACHIEVEMENTS = {
  break_first: 'Demolitionist — break your first block',
  own_world: 'Landlord — own a world',
  trade_first: 'Dealmaker — complete a trade',
  farmer: 'Farmer — harvest a tree',
  splicer: 'Geneticist — splice two seeds',
  rich: 'Tycoon — hold 1000 gems',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const WORLDS_DIR = path.join(DATA, 'worlds');
const PROFILES_FILE = path.join(DATA, 'profiles.json');
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DEV_ACCOUNTS = new Set(['XtremeFire']);
const DEV_GEM_BALANCE = Number.MAX_SAFE_INTEGER;

fs.mkdirSync(WORLDS_DIR, { recursive: true });

// ---------- in-memory state ----------
const worlds = new Map();     // NAME -> World (loaded)
const players = new Map();    // id -> player
const profiles = loadProfiles(); // name -> { gems, inventory, achievements, ownedWorlds }
const accounts = loadAccounts();  // name -> { salt, hash }   (the account "database")
let nextId = 1;
let dropSeq = 1;
const dirtyWorlds = new Set();

// ---------- static HTTP ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(url));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = nextId++;
  const player = {
    id, ws, name: null, world: null,
    x: 0, y: 0, vx: 0, vy: 0, dir: 1, anim: 'idle',
    inventory: {}, gems: 0, trade: null, dead: false,
  };
  players.set(id, player);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    try { handle(player, msg); } catch (e) { console.error('handler error', e); }
  });

  ws.on('close', () => {
    if (player.trade) cancelTrade(player, 'Partner disconnected.');
    if (player.world) leaveWorld(player);
    saveProfile(player);
    players.delete(id);
  });
});

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}
function toPlayer(p, type, payload) { send(p.ws, type, payload); }

function broadcast(worldName, type, payload, exceptId = null) {
  for (const p of players.values()) {
    if (p.world === worldName && p.id !== exceptId) send(p.ws, type, payload);
  }
}

function playersInWorld(worldName) {
  const list = [];
  for (const p of players.values()) {
    if (p.world === worldName && p.name) list.push(publicPlayer(p));
  }
  return list;
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, dir: p.dir, anim: p.anim, punchAngle: p.punchAngle || 0, punchDist: p.punchDist || 0, punchSeq: p.punchSeq ?? 0 };
}

function isDeveloperName(name) { return DEV_ACCOUNTS.has(name) && !!accounts[name]; }
function isDeveloper(p) { return !!(p && isDeveloperName(p.name)); }
function gemBalance(p) { return isDeveloper(p) ? DEV_GEM_BALANCE : (p.gems || 0); }
function canAffordGems(p, amount) { return isDeveloper(p) || (p.gems || 0) >= amount; }
function spendGems(p, amount) { if (isDeveloper(p)) p.gems = DEV_GEM_BALANCE; else p.gems -= amount; }
function grantGems(p, amount) { p.gems = isDeveloper(p) ? DEV_GEM_BALANCE : (p.gems || 0) + amount; }
function offerGems(p, value) {
  const n = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(gemBalance(p), n));
}

// ---------- message router ----------
function handle(p, msg) {
  switch (msg.type) {
    case 'join':        return onJoin(p, msg);
    case 'register':    return onRegister(p, msg);
    case 'login':       return onLogin(p, msg);
    case 'getProfile':  return onGetProfile(p, msg);
    case 'getWorlds':   return onGetWorlds(p);
    case 'enterWorld':  return onEnterWorld(p, msg);
    case 'leaveWorld':  return (p.world && leaveWorld(p), onGetWorlds(p));
    case 'move':        return onMove(p, msg);
    case 'break':       return onBreak(p, msg);
    case 'place':       return onPlace(p, msg);
    case 'buy':         return onBuy(p, msg);
    case 'splice':      return onSplice(p, msg);
    case 'addAdmin':    return onAddAdmin(p, msg);
    case 'respawn':     return onRespawn(p);
    case 'chat':        return onChat(p, msg);
    case 'tradeRequest': return onTradeRequest(p, msg);
    case 'tradeAccept':  return onTradeAccept(p, msg);
    case 'tradeOffer':   return onTradeOffer(p, msg);
    case 'tradeConfirm': return onTradeConfirm(p);
    case 'tradeCancel':  return cancelTrade(p, 'Trade cancelled.');
  }
}

// ---------- accounts / login / profiles ----------
function sanitizeName(n) { return String(n || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16); }

function loginSuccess(p, name) {
  if ([...players.values()].some((pl) => pl !== p && pl.name === name)) {
    return toPlayer(p, 'authError', { text: 'That account is already logged in.' });
  }
  p.name = name;
  const prof = profiles[name];
  if (prof) {
    p.gems = prof.gems || 0;
    p.inventory = { ...(prof.inventory || {}) };
    p.achievements = prof.achievements || [];
    p.ownedWorlds = prof.ownedWorlds || [];
  } else {
    p.gems = 100;
    p.inventory = { dirt: 10, dirt_seed: 3, small_lock: 1 };
    p.achievements = []; p.ownedWorlds = [];
  }
  if (isDeveloper(p)) p.gems = DEV_GEM_BALANCE;
  for (const t of PERMANENT) p.inventory[t] = 1; // always-present tools
  saveProfile(p);
  toPlayer(p, 'welcome', { id: p.id, name: p.name, gems: gemBalance(p), inventory: p.inventory });
  onGetWorlds(p);
}

function onJoin(p, msg) {            // guest login (no password)
  const name = sanitizeName(msg.name) || ('Guest' + p.id);
  if (accounts[name]) return toPlayer(p, 'authError', { text: 'That name is registered. Please log in.' });
  loginSuccess(p, name);
}

function onRegister(p, msg) {
  const name = sanitizeName(msg.name);
  if (name.length < 3) return toPlayer(p, 'authError', { text: 'Name needs 3+ letters or numbers.' });
  if (String(msg.password || '').length < 4) return toPlayer(p, 'authError', { text: 'Password needs 4+ characters.' });
  if (accounts[name]) return toPlayer(p, 'authError', { text: 'That name is already taken.' });
  accounts[name] = hashPw(String(msg.password));
  saveAccounts();
  loginSuccess(p, name);
}

function onLogin(p, msg) {
  const name = sanitizeName(msg.name);
  const acc = accounts[name];
  if (!acc || !verifyPw(String(msg.password || ''), acc)) {
    return toPlayer(p, 'authError', { text: 'Wrong name or password.' });
  }
  loginSuccess(p, name);
}

function onGetProfile(p, msg) {
  let name = null;
  if (msg.id != null) { const t = players.get(msg.id); if (t) name = t.name; }
  if (!name && msg.name) name = sanitizeName(msg.name);
  if (!name) return;
  const online = [...players.values()].find((pl) => pl.name === name);
  const prof = online ? { gems: gemBalance(online), inventory: online.inventory, achievements: online.achievements, ownedWorlds: online.ownedWorlds } : (profiles[name] || {});
  const inv = prof.inventory || {};
  const effects = [];
  if (hasEffect(inv, 'double_jump')) effects.push('🪽 Double Jump (Angel Wings)');
  if (hasEffect(inv, 'long_punch')) effects.push('👁️ Long Punch (Cyclopean Visor)');
  toPlayer(p, 'profile', {
    name, online: !!online, gems: isDeveloperName(name) ? DEV_GEM_BALANCE : (prof.gems || 0),
    achievements: (prof.achievements || []).map((id) => ACHIEVEMENTS[id] || id),
    ownedWorlds: prof.ownedWorlds || [],
    effects,
  });
}

function award(p, id) {
  if (!p.achievements) p.achievements = [];
  if (p.achievements.includes(id)) return;
  p.achievements.push(id);
  toPlayer(p, 'notify', { text: '🏆 ' + ACHIEVEMENTS[id] });
  saveProfile(p);
}

// ---------- password hashing (file-based account DB) ----------
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPw(pw, acc) {
  try {
    const h = crypto.scryptSync(pw, acc.salt, 32).toString('hex');
    const a = Buffer.from(h, 'hex'), b = Buffer.from(acc.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function loadAccounts() { try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return {}; } }
function saveAccounts() { fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts), () => {}); }

function onGetWorlds(p) {
  const names = new Set();
  for (const n of worlds.keys()) names.add(n);
  for (const f of fs.readdirSync(WORLDS_DIR)) if (f.endsWith('.json')) names.add(f.slice(0, -5));
  const list = [...names].map((n) => {
    const w = worlds.get(n);
    return {
      name: n,
      players: [...players.values()].filter((pl) => pl.world === n).length,
      owner: w ? w.owner : peekOwner(n),
    };
  }).sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
  toPlayer(p, 'worldList', { worlds: list });
}

function peekOwner(name) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(WORLDS_DIR, name + '.json'), 'utf8'));
    return o.owner || null;
  } catch { return null; }
}

// ---------- world lifecycle ----------
function getWorld(name) {
  name = name.toUpperCase();
  if (worlds.has(name)) return worlds.get(name);
  const file = path.join(WORLDS_DIR, name + '.json');
  let w;
  if (fs.existsSync(file)) {
    w = World.deserialize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } else {
    w = new World(name);
    dirtyWorlds.add(name);
  }
  w.drops = [];
  worlds.set(name, w);
  return w;
}

function onEnterWorld(p, msg) {
  let name = String(msg.name || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 18).toUpperCase();
  if (!name) return;
  if (p.world) leaveWorld(p);
  const w = getWorld(name);
  p.world = name;
  const sp = w.spawnPixel();
  p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0; p.dead = false;

  toPlayer(p, 'worldData', {
    world: w.serialize(),
    drops: w.drops,
    players: playersInWorld(name).filter((pl) => pl.id !== p.id),
    you: publicPlayer(p),
    canBuild: w.canModify(p.name, w.spawn.tx, w.spawn.ty + 2),
  });
  broadcast(name, 'playerJoin', { player: publicPlayer(p) }, p.id);
}

function leaveWorld(p) {
  const name = p.world;
  broadcast(name, 'playerLeave', { id: p.id });
  p.world = null;
  scheduleSave(name);
}

// ---------- movement + auto pickup ----------
function onMove(p, msg) {
  if (!p.world) return;
  p.x = msg.x; p.y = msg.y; p.vx = msg.vx; p.vy = msg.vy;
  p.dir = msg.dir; p.anim = msg.anim; p.punchAngle = msg.punchAngle || 0; p.punchDist = msg.punchDist || 0; p.punchSeq = msg.punchSeq ?? 0;
  broadcast(p.world, 'playerMove', publicPlayer(p), p.id);

  // server-side auto pickup of nearby drops
  const w = worlds.get(p.world);
  if (!w || !w.drops.length) return;
  const collected = [];
  w.drops = w.drops.filter((d) => {
    const dx = d.x - p.x, dy = d.y - (p.y - TILE / 2);
    if (Math.hypot(dx, dy) <= PICKUP_RADIUS) { collected.push(d); return false; }
    return true;
  });
  for (const d of collected) {
    grant(p, d.item, d.count);
    broadcast(p.world, 'dropRemove', { id: d.id });
  }
  if (collected.length) sendInventory(p);
}

// ---------- breaking / harvesting ----------
function onBreak(p, msg) {
  const w = worlds.get(p.world); if (!w) return;
  const { x, y } = msg;
  if (!w.inBounds(x, y)) return;
  if (!withinReach(p, x, y)) return;
  const i = w.idx(x, y);
  const fg = w.fg[i];
  if (!fg) return;

  // harvest a mature tree
  if (fg === '__tree__') {
    if (w.treeReady(i)) {
      const seedId = w.data[i].tree.seed;
      w.clearTile(x, y);
      broadcast(p.world, 'tileUpdate', { x, y, fg: '', data: null });
      for (const drop of rollHarvest(seedId)) spawnDrop(w, x, y, drop.item, drop.count);
      award(p, 'farmer');
      scheduleSave(p.world);
    }
    return;
  }

  const def = ITEMS[fg];
  if (!def) return;
  if (w.data[i] && w.data[i].main) { return toPlayer(p, 'notify', { text: "The world's main door can't be broken." }); }
  if (def.hardness === Infinity) return; // bedrock / locks (locks broken via owner only below)

  // lock removal — only owner may remove their lock
  if (def.type === 'lock') {
    const d = w.data[i];
    if (!d || !d.lock || (d.lock.owner !== p.name && !d.lock.admins.includes(p.name))) {
      return toPlayer(p, 'notify', { text: 'Only the lock owner can remove it.' });
    }
    if (d.lock.scope === 'world') {
      w.owner = null; w.admins = [];
      p.ownedWorlds = (p.ownedWorlds || []).filter((n) => n !== w.name);
      saveProfile(p);
    }
    grant(p, fg, 1);
    w.clearTile(x, y);
    broadcast(p.world, 'tileUpdate', { x, y, fg: '', data: null });
    sendInventory(p);
    scheduleSave(p.world);
    return;
  }

  if (!w.canModify(p.name, x, y)) {
    const info = w.ownerInfoAt(x, y);
    return toPlayer(p, 'notify', { text: `Area locked by ${info ? info.owner : 'someone'}.` });
  }

  // accumulate break progress
  const now = Date.now();
  let b = w.breaking[i];
  if (!b || now - b.last > BREAK_RESET_MS) b = { hits: 0, last: now };
  b.hits++; b.last = now;
  w.breaking[i] = b;
  broadcast(p.world, 'breakProgress', { x, y, hits: b.hits, hardness: def.hardness });

  if (b.hits >= def.hardness) {
    w.clearTile(x, y);
    broadcast(p.world, 'tileUpdate', { x, y, fg: '', data: null });
    for (const drop of rollDrops(fg)) spawnDrop(w, x, y, drop.item, drop.count);
    award(p, 'break_first');
    scheduleSave(p.world);
  }
}

// ---------- placing / planting / locking ----------
function onPlace(p, msg) {
  const w = worlds.get(p.world); if (!w) return;
  const { x, y, itemId } = msg;
  const layer = msg.layer || 0;
  if (!w.inBounds(x, y) || !withinReach(p, x, y)) return;
  if (!has(p, itemId, 1)) return;
  const def = ITEMS[itemId]; if (!def) return;
  if (!isPlaceable(itemId)) return; // tools / effects / currency can't be placed
  const i = w.idx(x, y);

  if (def.type === 'lock') {
    if (!w.placeLock(p.name, x, y, itemId)) {
      return toPlayer(p, 'notify', { text: 'Cannot place a lock here.' });
    }
    take(p, itemId, 1);
    broadcast(p.world, 'tileUpdate', { x, y, fg: itemId, data: w.data[i] });
    sendInventory(p);
    if (def.lock.scope === 'world') {
      if (!p.ownedWorlds) p.ownedWorlds = [];
      if (!p.ownedWorlds.includes(w.name)) p.ownedWorlds.push(w.name);
      award(p, 'own_world');
      saveProfile(p);
      toPlayer(p, 'notify', { text: `You now own ${w.name}!` });
    }
    scheduleSave(p.world);
    return;
  }

  if (!w.canModify(p.name, x, y)) {
    const info = w.ownerInfoAt(x, y);
    return toPlayer(p, 'notify', { text: `Area locked by ${info ? info.owner : 'someone'}.` });
  }

  // seeds -> plant a tree
  if (def.type === 'seed') {
    if (!w.plant(x, y, itemId)) return;
    take(p, itemId, 1);
    broadcast(p.world, 'tileUpdate', { x, y, fg: '__tree__', data: w.data[i] });
    sendInventory(p);
    scheduleSave(p.world);
    return;
  }

  // background placement
  if (layer === 1) {
    if (w.bg[i]) return;
    w.bg[i] = itemId; take(p, itemId, 1);
    broadcast(p.world, 'tileUpdate', { x, y, bg: itemId });
    sendInventory(p); scheduleSave(p.world);
    return;
  }

  // foreground block
  if (w.fg[i]) return;
  // don't place a solid block on top of a player
  if (isSolid(itemId) && playerOverlapsTile(p.world, x, y)) {
    return toPlayer(p, 'notify', { text: "Can't place on a player." });
  }
  w.fg[i] = itemId; take(p, itemId, 1);
  broadcast(p.world, 'tileUpdate', { x, y, fg: itemId });
  sendInventory(p);
  scheduleSave(p.world);
}

function playerOverlapsTile(worldName, tx, ty) {
  for (const p of players.values()) {
    if (p.world !== worldName) continue;
    const px = Math.floor(p.x / TILE);
    const pyTop = Math.floor((p.y - PLAYER_H + 2) / TILE);
    const pyBot = Math.floor((p.y - 2) / TILE);
    if (px === tx && ty >= pyTop && ty <= pyBot) return true;
  }
  return false;
}

// ---------- shop / buy ----------
function onBuy(p, msg) {
  const it = ITEMS[msg.itemId];
  if (!it || it.price == null) return;
  const qty = Math.max(1, Math.min(99, msg.qty || 1));
  const cost = it.price * qty;
  if (!canAffordGems(p, cost)) return toPlayer(p, 'notify', { text: 'Not enough gems.' });
  spendGems(p, cost);
  grant(p, it.id, qty);
  sendInventory(p);
  toPlayer(p, 'notify', { text: `Bought ${qty}x ${it.name}.` });
  saveProfile(p);
}

// ---------- splicing ----------
function onSplice(p, msg) {
  const { a, b } = msg;
  if (!has(p, a, 1) || !has(p, b, 1)) return;
  const result = spliceResult(a, b);
  if (!result) return toPlayer(p, 'notify', { text: 'Those seeds don\'t splice into anything.' });
  take(p, a, 1); take(p, b, 1);
  grant(p, result, 1);
  sendInventory(p);
  award(p, 'splicer');
  toPlayer(p, 'notify', { text: `Spliced into ${ITEMS[result].name}!` });
}

// ---------- admins ----------
function onAddAdmin(p, msg) {
  const w = worlds.get(p.world); if (!w) return;
  if (w.owner !== p.name) return toPlayer(p, 'notify', { text: 'Only the world owner can add admins.' });
  const name = String(msg.name || '').trim().replace(/[^A-Za-z0-9_ ]/g, '').slice(0, 16);
  if (!name || name === p.name) return;
  if (!w.admins.includes(name)) w.admins.push(name);
  // sync to the world-lock tile data
  for (const k in w.data) if (w.data[k].lock && w.data[k].lock.scope === 'world') w.data[k].lock.admins = w.admins;
  toPlayer(p, 'notify', { text: `${name} is now an admin of ${w.name}.` });
  scheduleSave(p.world);
}

// ---------- respawn ----------
function onRespawn(p) {
  const w = worlds.get(p.world); if (!w) return;
  const sp = w.spawnPixel();
  p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0; p.dead = false;
  toPlayer(p, 'respawnAt', { x: sp.x, y: sp.y });
  broadcast(p.world, 'playerMove', publicPlayer(p), p.id);
}

// ---------- chat ----------
function onChat(p, msg) {
  if (!p.world) return;
  const text = String(msg.text || '').slice(0, 120);
  if (!text) return;
  broadcast(p.world, 'chat', { name: p.name, text });
}

// ---------- trading ----------
function onTradeRequest(p, msg) {
  const target = players.get(msg.targetId);
  if (!target || target.world !== p.world || target.id === p.id) return;
  if (p.trade || target.trade) return toPlayer(p, 'notify', { text: 'One of you is already trading.' });
  toPlayer(target, 'tradeRequest', { fromId: p.id, fromName: p.name });
  toPlayer(p, 'notify', { text: `Trade request sent to ${target.name}.` });
}
function onTradeAccept(p, msg) {
  const other = players.get(msg.fromId);
  if (!other || other.world !== p.world || p.trade || other.trade) return;
  p.trade = { partnerId: other.id, items: {}, gems: 0, confirmed: false };
  other.trade = { partnerId: p.id, items: {}, gems: 0, confirmed: false };
  sendTradeWindow(p, other);
  sendTradeWindow(other, p);
}
function onTradeOffer(p, msg) {
  if (!p.trade) return;
  const other = players.get(p.trade.partnerId);
  if (!other || !other.trade) return;
  // validate offered items are owned
  const items = {};
  for (const [id, c] of Object.entries(msg.items || {})) {
    if (ITEMS[id] && ITEMS[id].permanent) continue; // can't trade away tools
    const count = Math.max(0, Math.min(has(p, id, 1e9) ? p.inventory[id] : 0, c | 0));
    if (count > 0) items[id] = count;
  }
  p.trade.items = items;
  p.trade.gems = offerGems(p, msg.gems);
  // any change unconfirms both sides
  p.trade.confirmed = false; other.trade.confirmed = false;
  sendTradeWindow(p, other);
  sendTradeWindow(other, p);
}
function onTradeConfirm(p) {
  if (!p.trade) return;
  const other = players.get(p.trade.partnerId);
  if (!other || !other.trade) return;
  p.trade.confirmed = true;
  sendTradeWindow(p, other);
  sendTradeWindow(other, p);
  if (p.trade.confirmed && other.trade.confirmed) executeTrade(p, other);
}
function executeTrade(a, b) {
  // verify both still own what they offered
  for (const [id, c] of Object.entries(a.trade.items)) if (!has(a, id, c)) return cancelTrade(a, 'Trade failed: item missing.');
  for (const [id, c] of Object.entries(b.trade.items)) if (!has(b, id, c)) return cancelTrade(b, 'Trade failed: item missing.');
  if (!canAffordGems(a, a.trade.gems) || !canAffordGems(b, b.trade.gems)) return cancelTrade(a, 'Trade failed: not enough gems.');

  for (const [id, c] of Object.entries(a.trade.items)) { take(a, id, c); grant(b, id, c); }
  for (const [id, c] of Object.entries(b.trade.items)) { take(b, id, c); grant(a, id, c); }
  spendGems(a, a.trade.gems); grantGems(b, a.trade.gems);
  spendGems(b, b.trade.gems); grantGems(a, b.trade.gems);

  a.trade = null; b.trade = null;
  sendInventory(a); sendInventory(b);
  toPlayer(a, 'tradeDone', {}); toPlayer(b, 'tradeDone', {});
  toPlayer(a, 'notify', { text: 'Trade complete!' }); toPlayer(b, 'notify', { text: 'Trade complete!' });
  award(a, 'trade_first'); award(b, 'trade_first');
  saveProfile(a); saveProfile(b);
}
function cancelTrade(p, reason) {
  const other = p.trade ? players.get(p.trade.partnerId) : null;
  if (p.trade) p.trade = null;
  if (other && other.trade) { other.trade = null; toPlayer(other, 'tradeDone', {}); toPlayer(other, 'notify', { text: reason }); }
  toPlayer(p, 'tradeDone', {});
  toPlayer(p, 'notify', { text: reason });
}
function sendTradeWindow(p, other) {
  toPlayer(p, 'tradeWindow', {
    partnerName: other.name,
    yourItems: p.trade.items, yourGems: p.trade.gems, youConfirmed: p.trade.confirmed,
    theirItems: other.trade.items, theirGems: other.trade.gems, theyConfirmed: other.trade.confirmed,
  });
}

// ---------- inventory helpers ----------
function has(p, id, n) { return (p.inventory[id] || 0) >= n; }
function grant(p, id, n) {
  if (id === 'gem') { grantGems(p, n); return; }
  p.inventory[id] = (p.inventory[id] || 0) + n;
}
function take(p, id, n) {
  p.inventory[id] = (p.inventory[id] || 0) - n;
  if (p.inventory[id] <= 0) delete p.inventory[id];
}
function sendInventory(p) {
  toPlayer(p, 'inventory', { inventory: p.inventory, gems: gemBalance(p) });
  if (gemBalance(p) >= 1000) award(p, 'rich');
  saveProfile(p);
}

// ---------- drops ----------
function spawnDrop(w, tx, ty, item, count) {
  const drop = {
    id: dropSeq++,
    x: tx * TILE + TILE / 2 + (Math.random() * 10 - 5),
    y: ty * TILE + TILE / 2,
    item, count, bornAt: Date.now(),
  };
  w.drops.push(drop);
  broadcast(w.name, 'dropAdd', { drop });
}

// ---------- reach check (longer with a Cyclopean Visor) ----------
function withinReach(p, tx, ty) {
  const reach = REACH + (hasEffect(p.inventory, 'long_punch') ? 2 : 0);
  const px = p.x / TILE, py = (p.y - TILE / 2) / TILE;
  return Math.abs(px - (tx + 0.5)) <= reach + 0.5 && Math.abs(py - (ty + 0.5)) <= reach + 0.5;
}

// ---------- persistence ----------
function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch { return {}; }
}
function saveProfile(p) {
  if (!p.name) return;
  profiles[p.name] = { gems: gemBalance(p), inventory: p.inventory, achievements: p.achievements || [], ownedWorlds: p.ownedWorlds || [] };
  clearTimeout(saveProfile._t);
  saveProfile._t = setTimeout(() => {
    fs.writeFile(PROFILES_FILE, JSON.stringify(profiles), () => {});
  }, 500);
}
function scheduleSave(name) { dirtyWorlds.add(name); }

setInterval(() => {
  for (const name of dirtyWorlds) {
    const w = worlds.get(name);
    if (w) fs.writeFile(path.join(WORLDS_DIR, name + '.json'), JSON.stringify(w.serialize()), () => {});
  }
  dirtyWorlds.clear();
}, 5000);

// despawn old drops
setInterval(() => {
  const now = Date.now();
  for (const w of worlds.values()) {
    if (!w.drops) continue;
    const expired = w.drops.filter((d) => now - d.bornAt > DROP_LIFETIME_MS);
    if (expired.length) {
      w.drops = w.drops.filter((d) => now - d.bornAt <= DROP_LIFETIME_MS);
      for (const d of expired) broadcast(w.name, 'dropRemove', { id: d.id });
    }
  }
}, 5000);

// recover damaged blocks that haven't been punched again within BREAK_RESET_MS
setInterval(() => {
  const now = Date.now();
  for (const w of worlds.values()) {
    if (!w.breaking) continue;
    for (const i in w.breaking) {
      if (now - w.breaking[i].last > BREAK_RESET_MS) {
        delete w.breaking[i];
        broadcast(w.name, 'breakReset', { x: Number(i) % w.width, y: Math.floor(Number(i) / w.width) });
      }
    }
  }
}, 1000);

// unload empty worlds (keep memory tidy)
setInterval(() => {
  for (const [name, w] of worlds) {
    const occupied = [...players.values()].some((p) => p.world === name);
    if (!occupied && (!w.drops || w.drops.length === 0) && !dirtyWorlds.has(name)) {
      fs.writeFileSync(path.join(WORLDS_DIR, name + '.json'), JSON.stringify(w.serialize()));
      worlds.delete(name);
    }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`\n  🌱 Growtopia Clone running:  http://${HOST}:${PORT}\n`);
});
