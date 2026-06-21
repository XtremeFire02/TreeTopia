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
  PERMANENT, STARTER_CLOTHING, hasEffect, isPlaceable, isClothing, PACK_BY_ID,
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
const DEVELOPERS_FILE = path.join(DATA, 'developers.json');
const GAMEBANS_FILE = path.join(DATA, 'gamebans.json');
const WORLD_BAN_MS = 30 * 60 * 1000;   // world-owner ban duration (30 minutes)
const SUPER_COST = 500;                // SuperBroadcast gem cost
const SUPER_COOLDOWN = 10 * 60 * 1000; // SuperBroadcast cooldown
const BROADCAST_REACH = 50;            // a Broadcast reaches this many random players
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Sprite Studio asset pipeline. The /studio editor is reachable on the live
// server, but every write is gated by a secret key (revealed in-game to
// developers via /studiokey). Custom items + their PNGs live in the persistent
// data dir, so they survive deploys (which ship fresh release dirs).
const STUDIO_HTML = path.join(__dirname, '..', 'tools', 'sprite-editor.html');
const CUSTOM_DATA = path.join(DATA, 'custom');
const CUSTOM_ASSETS = path.join(CUSTOM_DATA, 'assets');
const CUSTOM_ITEMS_JSON = path.join(CUSTOM_DATA, 'items.json');
const STUDIO_KEY_FILE = path.join(CUSTOM_DATA, 'studio-key.txt');
let studioKey = '';
const customStore = {};   // id -> custom item definition (the editable layer)
const DEV_ACCOUNT_NAME = '@XtremeFire';
// The founder account is always a developer. Additional developers are granted
// at runtime by an existing developer and persisted in developers.json.
const DEV_ACCOUNTS = new Set([DEV_ACCOUNT_NAME.toLowerCase()]);
const DEV_GEM_BALANCE = Number.MAX_SAFE_INTEGER;
const REGULAR_NAME_RE = /^[A-Za-z0-9]{3,16}$/;
const USERNAME_RULE_TEXT = 'Names must be 3-16 letters or numbers only. No spaces or special characters.';
const AUTH_MESSAGES = new Set(['join', 'register', 'login']);

fs.mkdirSync(WORLDS_DIR, { recursive: true });

// ---------- in-memory state ----------
const worlds = new Map();     // NAME -> World (loaded)
const players = new Map();    // id -> player
const profiles = loadProfiles(); // name -> { gems, inventory, achievements, ownedWorlds, equipped }
const accounts = loadAccounts();  // name -> { salt, hash }   (the account "database")
const developers = loadDevelopers(); // Set of lowercased account names granted developer status
const gameBans = loadGameBans();     // Set of lowercased account names banned from the whole game
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
  const url = decodeURIComponent(req.url.split('?')[0]);
  // allow the studio (even opened as a local file) to call the API cross-origin
  if (req.method === 'OPTIONS' && (url.startsWith('/api/') || url.startsWith('/custom-assets/'))) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-studio-key, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return res.end();
  }
  if (url === '/studio' || url.startsWith('/api/studio/')) return handleStudio(req, res, url);
  if (url === '/api/custom-items') return sendJson(res, 200, customStore);     // public: clients merge these
  if (url.startsWith('/custom-assets/')) return serveCustomAsset(res, url);

  let p = url === '/' ? '/index.html' : url;
  const filePath = path.join(PUBLIC, path.normalize(p));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ---------- Sprite Studio asset API ----------
// Custom items + assets live in the persistent data dir so they survive deploys.
// Reads are public; writes require the secret studio key (see /studiokey in-game).
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function writePngDataUrl(file, dataUrl) {
  const i = String(dataUrl || '').indexOf('base64,');
  if (i < 0) return false;
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(i + 7), 'base64'));
  return true;
}
function serveCustomAsset(res, url) {
  const name = path.basename(url);
  const f = path.join(CUSTOM_ASSETS, name);
  if (!f.startsWith(CUSTOM_ASSETS)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(buf);
  });
}
function initStudio() {
  fs.mkdirSync(CUSTOM_ASSETS, { recursive: true });
  try { studioKey = fs.readFileSync(STUDIO_KEY_FILE, 'utf8').trim(); } catch { studioKey = ''; }
  if (!studioKey) { studioKey = crypto.randomBytes(6).toString('hex'); fs.writeFileSync(STUDIO_KEY_FILE, studioKey); }
  try {
    const saved = JSON.parse(fs.readFileSync(CUSTOM_ITEMS_JSON, 'utf8'));
    for (const id in saved) { customStore[id] = saved[id]; ITEMS[id] = { ...(ITEMS[id] || {}), ...saved[id] }; }
  } catch { /* none yet */ }
}
function persistCustomItems() { fs.writeFileSync(CUSTOM_ITEMS_JSON, JSON.stringify(customStore, null, 2)); }
function studioOk(req) {
  const key = (req.headers['x-studio-key'] || '').trim()
    || (new URLSearchParams((req.url.split('?')[1] || '')).get('key') || '').trim();
  return studioKey && key === studioKey;
}
function studioItemList() {
  return Object.values(ITEMS).map((it) => ({
    id: it.id, name: it.name, type: it.type, category: it.category || null,
    price: it.price ?? null, frames: it.frames || 1, frameMs: it.frameMs || null,
    sprite: it.sprite || null, sheet: it.sheet || null, slot: it.slot || null,
    custom: !!customStore[it.id],
  })).sort((a, b) => Number(b.custom) - Number(a.custom) || a.id.localeCompare(b.id));
}
async function handleStudio(req, res, url) {
  if (url === '/studio') {
    return fs.readFile(STUDIO_HTML, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('studio html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(buf);
    });
  }
  // every /api/studio/* call requires the secret key
  if (!studioOk(req)) return sendJson(res, 403, { error: 'A valid studio key is required.', needKey: true });

  if (url === '/api/studio/items' && req.method === 'GET') return sendJson(res, 200, { items: studioItemList() });

  if (url === '/api/studio/source' && req.method === 'GET') {
    const id = (new URLSearchParams(req.url.split('?')[1] || '')).get('id') || '';
    const f = path.join(CUSTOM_ASSETS, path.basename(id) + '.studio.json');
    return fs.readFile(f, 'utf8', (err, txt) => err ? sendJson(res, 404, { error: 'no source' }) : sendJson(res, 200, JSON.parse(txt)));
  }

  if (url === '/api/studio/save' && req.method === 'POST') {
    const body = await readBody(req);
    const def = body.def || {};
    const id = String(def.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!id) return sendJson(res, 400, { error: 'A valid id (letters, numbers, _) is required.' });
    try {
      fs.mkdirSync(CUSTOM_ASSETS, { recursive: true });
      writePngDataUrl(path.join(CUSTOM_ASSETS, id + '.png'), body.iconPng);     // first frame (icon + static draw)
      def.sprite = `/custom-assets/${id}.png`;
      if ((def.frames || 1) > 1 && body.sheetPng) {
        writePngDataUrl(path.join(CUSTOM_ASSETS, id + '_sheet.png'), body.sheetPng);
        def.sheet = `/custom-assets/${id}_sheet.png`;
      } else { delete def.sheet; }
      if (body.studio) fs.writeFileSync(path.join(CUSTOM_ASSETS, id + '.studio.json'), JSON.stringify(body.studio));
      def.id = id;
      customStore[id] = def;
      ITEMS[id] = { ...(ITEMS[id] || {}), ...def };   // hot-apply to the running game
      persistCustomItems();
      return sendJson(res, 200, { ok: true, item: def });
    } catch (e) { return sendJson(res, 500, { error: String(e && e.message || e) }); }
  }

  if (url === '/api/studio/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (!customStore[id]) return sendJson(res, 400, { error: 'Only custom items can be deleted.' });
    delete customStore[id];
    delete ITEMS[id];
    for (const ext of ['.png', '_sheet.png', '.studio.json']) { try { fs.unlinkSync(path.join(CUSTOM_ASSETS, id + ext)); } catch { /* ok */ } }
    persistCustomItems();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'unknown studio endpoint' });
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = nextId++;
  const player = {
    id, ws, name: null, world: null,
    x: 0, y: 0, vx: 0, vy: 0, dir: 1, anim: 'idle',
    inventory: {}, gems: 0, trade: null, dead: false,
    equipped: {}, dev: false,
  };
  players.set(id, player);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    try { handle(player, msg); } catch (e) { console.error('handler error', e); }
  });

  ws.on('close', () => {
    if (player.trade) cancelTrade(player, 'Partner disconnected.');
    if (player.world) leaveWorld(player);
    if (player.name) player.lastSeen = Date.now();   // remember when they were last online
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
  return {
    id: p.id, name: p.name, dev: isDeveloper(p), equipped: p.equipped || {},
    x: p.x, y: p.y, dir: p.dir, anim: p.anim,
    punchAngle: p.punchAngle || 0, punchDist: p.punchDist || 0, punchSeq: p.punchSeq ?? 0,
  };
}

function normalizeAccountName(name) { return String(name || '').toLowerCase(); }
function isReservedDeveloperName(name) { return DEV_ACCOUNTS.has(normalizeAccountName(name)); }
function canonicalAccountName(name) {
  const clean = String(name || '').trim();
  return isReservedDeveloperName(clean) ? DEV_ACCOUNT_NAME : clean;
}
function accountKeyFor(name) {
  const lower = normalizeAccountName(name);
  if (!lower) return null;
  return Object.keys(accounts).find((key) => normalizeAccountName(key) === lower) || null;
}
function canonicalExistingAccountName(name) {
  return accountKeyFor(name) || canonicalAccountName(name);
}
function validateAccountName(name, { allowDeveloper = false, allowEmpty = false } = {}) {
  const clean = canonicalAccountName(name);
  if (!clean) return { name: clean, error: allowEmpty ? null : USERNAME_RULE_TEXT };
  if (isReservedDeveloperName(clean)) {
    return allowDeveloper
      ? { name: DEV_ACCOUNT_NAME, error: null }
      : { name: clean, error: 'The @XtremeFire developer account must be created by the server owner.' };
  }
  if (clean.includes('@')) return { name: clean, error: 'Only @XtremeFire can use @ in a name.' };
  if (!REGULAR_NAME_RE.test(clean)) return { name: clean, error: USERNAME_RULE_TEXT };
  return { name: clean, error: null };
}
function isDeveloperName(name) {
  if (isReservedDeveloperName(name)) return !!accounts[DEV_ACCOUNT_NAME];
  return developers.has(normalizeAccountName(name));
}
function isDeveloper(p) { return !!(p && isDeveloperName(p.name)); }
// Developers display with infinite gems, but we keep their REAL balance in
// p.gems untouched so the value survives if their developer status is removed.
function gemBalance(p) { return isDeveloper(p) ? DEV_GEM_BALANCE : (p.gems || 0); }
function canAffordGems(p, amount) { return isDeveloper(p) || (p.gems || 0) >= amount; }
function spendGems(p, amount) { if (!isDeveloper(p)) p.gems = Math.max(0, (p.gems || 0) - amount); }
function grantGems(p, amount) { if (!isDeveloper(p)) p.gems = (p.gems || 0) + amount; }

function loadDevelopers() {
  try { return new Set(JSON.parse(fs.readFileSync(DEVELOPERS_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveDevelopers() { fs.writeFile(DEVELOPERS_FILE, JSON.stringify([...developers]), () => {}); }
function loadGameBans() {
  try { return new Set(JSON.parse(fs.readFileSync(GAMEBANS_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveGameBans() { fs.writeFile(GAMEBANS_FILE, JSON.stringify([...gameBans]), () => {}); }
function isGameBanned(name) { return gameBans.has(normalizeAccountName(name)) && !isDeveloperName(name); }
function offerGems(p, value) {
  const n = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(gemBalance(p), n));
}

// ---------- message router ----------
function handle(p, msg) {
  if (AUTH_MESSAGES.has(msg.type)) {
    if (p.name) return toPlayer(p, 'authError', { text: 'You are already logged in.' });
  } else if (!p.name) {
    return;
  }

  switch (msg.type) {
    case 'join':        return onJoin(p, msg);
    case 'register':    return onRegister(p, msg);
    case 'login':       return onLogin(p, msg);
    case 'getProfile':  return onGetProfile(p, msg);
    case 'addFriend':   return onAddFriend(p, msg);
    case 'removeFriend': return onRemoveFriend(p, msg);
    case 'getFriends':  return onGetFriends(p);
    case 'warpToFriend': return onWarpToFriend(p, msg);
    case 'getWorlds':   return onGetWorlds(p);
    case 'enterWorld':  return onEnterWorld(p, msg);
    case 'leaveWorld':  return (p.world && leaveWorld(p), onGetWorlds(p));
    case 'move':        return onMove(p, msg);
    case 'break':       return onBreak(p, msg);
    case 'place':       return onPlace(p, msg);
    case 'buy':         return onBuy(p, msg);
    case 'buyPack':     return onBuyPack(p, msg);
    case 'splice':      return onSplice(p, msg);
    case 'equip':       return onEquip(p, msg);
    case 'setDeveloper': return onSetDeveloper(p, msg);
    case 'getDevelopers': return onGetDevelopers(p);
    case 'addAdmin':    return onAddAdmin(p, msg);
    case 'respawn':     return onRespawn(p);
    case 'chat':        return onChat(p, msg);
    case 'broadcast':   return onBroadcast(p, msg);
    case 'superBroadcast': return onSuperBroadcast(p, msg);
    case 'command':     return onCommand(p, msg);
    case 'deleteWorld': return onDeleteWorld(p, msg);
    case 'tradeRequest': return onTradeRequest(p, msg);
    case 'tradeAccept':  return onTradeAccept(p, msg);
    case 'tradeOffer':   return onTradeOffer(p, msg);
    case 'tradeConfirm': return onTradeConfirm(p);
    case 'tradeCancel':  return cancelTrade(p, 'Trade cancelled.');
  }
}

// ---------- accounts / login / profiles ----------

function loginSuccess(p, name, extra = {}) {
  if (isGameBanned(name)) {
    return toPlayer(p, 'authError', { text: 'You are banned from TreeTopia.' });
  }
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
    p.equipped = { ...(prof.equipped || {}) };
  } else {
    p.gems = 100;
    p.inventory = { dirt: 10, dirt_seed: 3, small_lock: 1 };
    p.achievements = []; p.ownedWorlds = [];
    p.equipped = {};          // spawn naked — clothing is equipped from the inventory
  }
  // migrate the old single 'body' outfit slot to the new 'shirt' slot
  if (p.equipped.body && !p.equipped.shirt) p.equipped.shirt = p.equipped.body;
  delete p.equipped.body;
  p.friends = (prof && Array.isArray(prof.friends)) ? prof.friends.slice() : [];
  p.lastSeen = Date.now();
  p.dev = isDeveloper(p);
  for (const t of PERMANENT) p.inventory[t] = 1;                 // always-present tools
  for (const c of STARTER_CLOTHING) if (!p.inventory[c]) p.inventory[c] = 1; // own your clothes
  saveProfile(p);
  toPlayer(p, 'welcome', { id: p.id, name: p.name, dev: p.dev, gems: gemBalance(p), inventory: p.inventory, equipped: p.equipped, ...extra });
  onGetWorlds(p);
}

function onJoin(p, msg) {            // guest login — each guest is its own persistent account
  // Returning guest: the client presents the name + token it saved last time.
  if (msg.guestName && msg.guestToken) {
    const name = canonicalExistingAccountName(msg.guestName);
    const acc = accounts[name];
    if (acc && acc.guest && verifyPw(String(msg.guestToken), acc)) {
      return loginSuccess(p, name);
    }
    // bad/expired token: fall through and mint a fresh guest below
  }
  // New guest: mint a unique random name + secret token and persist the account.
  const name = uniqueGuestName();
  const token = crypto.randomBytes(18).toString('hex');
  accounts[name] = { guest: true, ...hashPw(token) };
  saveAccounts();
  loginSuccess(p, name, { guestToken: token }); // client stores token to log back in
}

function uniqueGuestName() {
  for (let i = 0; i < 2000; i++) {
    const suffix = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/gi, '');
    const name = ('Guest' + suffix).slice(0, 16);
    if (name.length >= 3 && !accounts[name] && !isReservedDeveloperName(name)) return name;
  }
  return 'Guest' + Date.now().toString(36);
}

function onRegister(p, msg) {
  const { name, error } = validateAccountName(msg.name);
  if (error) return toPlayer(p, 'authError', { text: error });
  if (String(msg.password || '').length < 4) return toPlayer(p, 'authError', { text: 'Password needs 4+ characters.' });
  if (accountKeyFor(name)) return toPlayer(p, 'authError', { text: 'That name is already taken.' });
  accounts[name] = hashPw(String(msg.password));
  saveAccounts();
  loginSuccess(p, name);
}

function onLogin(p, msg) {
  const { name, error } = validateAccountName(msg.name, { allowDeveloper: true });
  if (error) return toPlayer(p, 'authError', { text: error });
  if (isReservedDeveloperName(name) && !accounts[DEV_ACCOUNT_NAME]) {
    return toPlayer(p, 'authError', { text: 'The @XtremeFire developer account has not been created on this server yet.' });
  }
  const actualName = canonicalExistingAccountName(name);
  const acc = accounts[actualName];
  if (!acc || !verifyPw(String(msg.password || ''), acc)) {
    return toPlayer(p, 'authError', { text: 'Wrong name or password.' });
  }
  loginSuccess(p, actualName);
}

function onGetProfile(p, msg) {
  let name = null;
  if (msg.id != null) { const t = players.get(msg.id); if (t) name = t.name; }
  if (!name && msg.name) {
    const result = validateAccountName(msg.name, { allowDeveloper: true });
    if (result.error) return;
    name = canonicalExistingAccountName(result.name);
  }
  if (!name) return;
  const online = [...players.values()].find((pl) => pl.name === name);
  const prof = online ? { gems: gemBalance(online), inventory: online.inventory, achievements: online.achievements, ownedWorlds: online.ownedWorlds } : (profiles[name] || {});
  const inv = prof.inventory || {};
  const effects = [];
  if (hasEffect(inv, 'double_jump')) effects.push('🪽 Double Jump (Angel Wings)');
  if (hasEffect(inv, 'long_punch')) effects.push('👁️ Long Punch (Cyclopean Visor)');
  const added = (p.friends || []).includes(name);
  const mutual = areMutual(p.name, name);
  toPlayer(p, 'profile', {
    name, online: !!online, dev: isDeveloperName(name),
    gems: isDeveloperName(name) ? DEV_GEM_BALANCE : (prof.gems || 0),
    achievements: (prof.achievements || []).map((id) => ACHIEVEMENTS[id] || id),
    ownedWorlds: prof.ownedWorlds || [],
    effects,
    isSelf: normalizeAccountName(name) === normalizeAccountName(p.name),
    added, friend: mutual,
    // last login is only revealed to mutual friends
    lastSeen: mutual ? lastSeenOf(name) : null,
    world: (mutual && online && online.world) ? online.world : null,
  });
}

// ---------- friends ----------
// Friendship is mutual: you're "friends" once both players have added each
// other (so warping into someone's world always has their consent).
function findOnline(name) {
  const lower = normalizeAccountName(name);
  return [...players.values()].find((pl) => pl.name && normalizeAccountName(pl.name) === lower) || null;
}
function friendsOf(name) { const on = findOnline(name); return (on ? on.friends : (profiles[name] && profiles[name].friends)) || []; }
function areMutual(a, b) { return friendsOf(a).includes(b) && friendsOf(b).includes(a); }
function lastSeenOf(name) { const on = findOnline(name); if (on) return Date.now(); return (profiles[name] && profiles[name].lastSeen) || null; }
function accountExists(name) { return !!accountKeyFor(name); }

// resolve the target account name from {id} (online player) or {name}
function resolveTargetName(msg) {
  if (msg.id != null) { const t = players.get(msg.id); if (t && t.name) return t.name; }
  if (msg.name) {
    const r = validateAccountName(msg.name, { allowDeveloper: true });
    if (!r.error) return canonicalExistingAccountName(r.name);
  }
  return null;
}

function friendListFor(p) {
  return (p.friends || []).map((name) => {
    const online = findOnline(name);
    const mutual = areMutual(p.name, name);
    return {
      name, dev: isDeveloperName(name),
      online: !!online, mutual,
      world: (mutual && online && online.world) ? online.world : null,
      lastSeen: online ? null : ((profiles[name] && profiles[name].lastSeen) || null),
    };
  });
}
function sendFriends(p) { toPlayer(p, 'friends', { friends: friendListFor(p) }); }

function onGetFriends(p) { if (p.name) sendFriends(p); }

function onAddFriend(p, msg) {
  if (!p.name) return;
  const target = resolveTargetName(msg);
  if (!target) return toPlayer(p, 'notify', { text: 'Could not find that player.' });
  if (normalizeAccountName(target) === normalizeAccountName(p.name)) return toPlayer(p, 'notify', { text: "You can't add yourself." });
  if (!accountExists(target)) return toPlayer(p, 'notify', { text: 'No such player.' });
  p.friends = p.friends || [];
  if (p.friends.includes(target)) return toPlayer(p, 'notify', { text: `${target} is already on your friends list.` });
  p.friends.push(target);
  saveProfile(p);
  if (areMutual(p.name, target)) {
    toPlayer(p, 'notify', { text: `You and ${target} are now friends! 🎉` });
    const t = findOnline(target);
    if (t) { toPlayer(t, 'notify', { text: `You and ${p.name} are now friends! 🎉` }); sendFriends(t); }
  } else {
    toPlayer(p, 'notify', { text: `Added ${target}. You'll be friends once they add you back.` });
    const t = findOnline(target);
    if (t) toPlayer(t, 'notify', { text: `${p.name} added you as a friend — add them back to become friends.` });
  }
  sendFriends(p);
}

function onRemoveFriend(p, msg) {
  if (!p.name) return;
  const target = resolveTargetName(msg) || String(msg.name || '');
  p.friends = (p.friends || []).filter((n) => n !== target);
  saveProfile(p);
  toPlayer(p, 'notify', { text: `Removed ${target} from your friends.` });
  const t = findOnline(target);
  if (t) sendFriends(t);   // their view of mutual-ness changed
  sendFriends(p);
}

function onWarpToFriend(p, msg) {
  if (!p.name) return;
  const target = resolveTargetName(msg) || String(msg.name || '');
  if (!areMutual(p.name, target)) return toPlayer(p, 'notify', { text: `You can only warp to mutual friends.` });
  const t = findOnline(target);
  if (!t) return toPlayer(p, 'notify', { text: `${target} is offline.` });
  if (!t.world) return toPlayer(p, 'notify', { text: `${target} isn't in a world right now.` });
  onEnterWorld(p, { name: t.world });
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
  const w = getWorld(name);
  const ban = worldBanRemaining(w, p.name);   // developers are immune (returns 0)
  if (ban && !isDeveloper(p)) {
    return toPlayer(p, 'notify', { text: ban === Infinity
      ? `You are permanently banned from ${name}.`
      : `You are banned from ${name} for ${Math.ceil(ban / 60000)} more min.` });
  }
  if (p.world) leaveWorld(p);
  p.world = name;
  const sp = w.spawnPixel();
  p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0; p.dead = false;

  toPlayer(p, 'worldData', {
    world: w.serialize(),
    drops: w.drops,
    players: playersInWorld(name).filter((pl) => pl.id !== p.id),
    you: publicPlayer(p),
    canBuild: w.canModify(p.name, w.spawn.tx, w.spawn.ty + 2),
    ownerDev: isDeveloperName(w.owner),
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
  if (w.data[i] && w.data[i].main) {
    // punching the world's main door while standing at it exits to world select
    if (playerOnTile(p, x, y)) return exitThroughDoor(p);
    return toPlayer(p, 'notify', { text: "The world's main door can't be broken — stand on it and punch to leave." });
  }

  // lock removal — only the owner, its admins, or a developer may break it, and
  // it takes the lock's full hardness (12 hits) like any other block.
  if (def.type === 'lock') {
    const d = w.data[i];
    const lockOwner = d && d.lock ? d.lock.owner : null;
    const allowed = isDeveloper(p) || (d && d.lock && (
      normalizeAccountName(lockOwner) === normalizeAccountName(p.name) ||
      (d.lock.admins || []).some((admin) => normalizeAccountName(admin) === normalizeAccountName(p.name))
    ));
    if (!allowed) {
      return toPlayer(p, 'notify', { text: 'Only the lock owner (or a developer) can remove it.' });
    }
    const tNow = Date.now();
    let lb = w.breaking[i];
    if (!lb || tNow - lb.last > BREAK_RESET_MS) lb = { hits: 0, last: tNow };
    lb.hits++; lb.last = tNow; w.breaking[i] = lb;
    broadcast(p.world, 'breakProgress', { x, y, hits: lb.hits, hardness: def.hardness });
    if (lb.hits >= def.hardness) {
      const worldLockRemoved = d.lock.scope === 'world';
      if (d.lock.scope === 'world') {
        w.owner = null; w.admins = [];
        removeOwnedWorld(lockOwner, w.name);
      }
      grant(p, fg, 1);
      w.clearTile(x, y);
      delete w.data[i];                  // free the locked area (clearTile keeps lock data)
      broadcast(p.world, 'tileUpdate', {
        x, y, fg: '', data: null,
        ...(worldLockRemoved ? { owner: w.owner, admins: w.admins, ownerDev: false } : {}),
      });
      sendInventory(p);
      scheduleSave(p.world);
    }
    return;
  }

  if (def.hardness === Infinity) return; // bedrock — unbreakable

  if (!isDeveloper(p) && !w.canModify(p.name, x, y)) {
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
    if (playerOverlapsTile(p.world, x, y)) {
      return toPlayer(p, 'notify', { text: "Can't place a lock on a player." });
    }
    if (!w.placeLock(p.name, x, y, itemId)) {
      return toPlayer(p, 'notify', { text: w.owner ? 'This world already has a World Lock.' : 'Cannot place a lock here.' });
    }
    take(p, itemId, 1);
    broadcast(p.world, 'tileUpdate', {
      x, y, fg: itemId, data: w.data[i],
      ...(def.lock.scope === 'world' ? { owner: w.owner, admins: w.admins, ownerDev: isDeveloperName(w.owner) } : {}),
    });
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

  if (!isDeveloper(p) && !w.canModify(p.name, x, y)) {
    const info = w.ownerInfoAt(x, y);
    return toPlayer(p, 'notify', { text: `Area locked by ${info ? info.owner : 'someone'}.` });
  }

  // seeds -> plant a tree, OR splice when planted over a still-growing tree
  if (def.type === 'seed') {
    if (w.fg[i] === '__tree__' && w.data[i] && w.data[i].tree && !w.treeReady(i)) {
      const existing = w.data[i].tree.seed;
      const result = spliceResult(existing, itemId);
      if (!result) return toPlayer(p, 'notify', { text: 'Those seeds don\'t splice into anything.' });
      take(p, itemId, 1);
      w.data[i] = { tree: { seed: result, plantedAt: Date.now(), growTime: ITEMS[result].growTime } };
      broadcast(p.world, 'tileUpdate', { x, y, fg: '__tree__', data: w.data[i] });
      sendInventory(p);
      award(p, 'splicer');
      toPlayer(p, 'notify', { text: `Spliced into ${ITEMS[result].name}!` });
      scheduleSave(p.world);
      return;
    }
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
    if (playerOnTile(p, tx, ty)) return true;
  }
  return false;
}

// does this specific player's body overlap tile (tx, ty)?
function playerOnTile(p, tx, ty) {
  const px = Math.floor(p.x / TILE);
  const pyTop = Math.floor((p.y - PLAYER_H + 2) / TILE);
  const pyBot = Math.floor((p.y - 2) / TILE);
  return px === tx && ty >= pyTop && ty <= pyBot;
}

// leave the world through the main door, back to the world-select screen
function exitThroughDoor(p) {
  const wn = p.world;
  if (!wn) return;
  broadcast(wn, 'playerLeave', { id: p.id });
  if (p.trade) cancelTrade(p, 'Trade cancelled.');
  p.world = null;
  scheduleSave(wn);
  toPlayer(p, 'kickedFromWorld', { reason: '🚪 You left through the door.' });
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

function onBuyPack(p, msg) {
  const pack = PACK_BY_ID[msg.packId];
  if (!pack) return;
  if (!canAffordGems(p, pack.price)) return toPlayer(p, 'notify', { text: 'Not enough gems.' });
  spendGems(p, pack.price);
  for (const [id, n] of Object.entries(pack.items)) if (ITEMS[id]) grant(p, id, n);
  sendInventory(p);
  toPlayer(p, 'notify', { text: `Bought the ${pack.name}!` });
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

// ---------- clothing: equip / unequip ----------
function onEquip(p, msg) {
  const id = msg.itemId;
  if (!isClothing(id) || !has(p, id, 1)) return;   // must own the garment to wear it
  const slot = ITEMS[id].slot || 'body';
  if (!p.equipped) p.equipped = {};
  if (p.equipped[slot] === id) delete p.equipped[slot]; // double-tap again to take it off
  else p.equipped[slot] = id;                           // wear it (replaces anything in that slot)
  sendInventory(p);                                     // updates the player's own view (+ equipped flags)
  if (p.world) broadcast(p.world, 'playerMove', publicPlayer(p), p.id); // others see the outfit change
  saveProfile(p);
}

// ---------- developer class: grant / remove (developers only) ----------
function onSetDeveloper(p, msg) {
  if (!isDeveloper(p)) return toPlayer(p, 'notify', { text: 'Only developers can manage developer status.' });
  const { name, error } = validateAccountName(msg.name, { allowDeveloper: true });
  if (error) return toPlayer(p, 'notify', { text: error });
  if (isReservedDeveloperName(name)) return toPlayer(p, 'notify', { text: 'The founder developer account cannot be changed.' });
  const actualName = canonicalExistingAccountName(name);
  const lower = normalizeAccountName(actualName);
  const grant = !!msg.grant;
  if (grant) developers.add(lower); else developers.delete(lower);
  saveDevelopers();

  // apply immediately to that player if they're online (without bouncing them
  // back to the world-select screen the way a full 'welcome' would)
  const target = [...players.values()].find((pl) => normalizeAccountName(pl.name) === lower);
  if (target) {
    target.dev = isDeveloper(target);
    toPlayer(target, 'devStatus', { dev: target.dev });
    sendInventory(target); // refresh gem display (infinite vs real)
    if (target.world) broadcast(target.world, 'playerMove', publicPlayer(target), target.id);
    toPlayer(target, 'notify', { text: grant ? '👑 You are now a developer!' : 'Your developer status was removed.' });
  }
  toPlayer(p, 'notify', { text: `${grant ? 'Granted' : 'Removed'} developer for ${actualName}.` });
  toPlayer(p, 'devList', { developers: [...developers] });
}

function onGetDevelopers(p) {
  if (!isDeveloper(p)) return;
  toPlayer(p, 'devList', { developers: [...developers] });
}

// Remove a world from its owner's profile (works whether they're online or not).
function removeOwnedWorld(name, worldName) {
  if (!name) return;
  const actualName = canonicalExistingAccountName(name);
  const online = findOnline(actualName);
  if (online) {
    online.ownedWorlds = (online.ownedWorlds || []).filter((n) => n !== worldName);
    saveProfile(online);
  } else if (profiles[actualName]) {
    profiles[actualName].ownedWorlds = (profiles[actualName].ownedWorlds || []).filter((n) => n !== worldName);
  }
}

// ---------- admins ----------
function onAddAdmin(p, msg) {
  const w = worlds.get(p.world); if (!w) return;
  if (normalizeAccountName(w.owner) !== normalizeAccountName(p.name)) return toPlayer(p, 'notify', { text: 'Only the world owner can add admins.' });
  let { name, error } = validateAccountName(msg.name, { allowDeveloper: true });
  if (error) return toPlayer(p, 'notify', { text: error });
  name = canonicalExistingAccountName(name);
  if (!name || normalizeAccountName(name) === normalizeAccountName(p.name)) return;
  if (!w.admins.some((admin) => normalizeAccountName(admin) === normalizeAccountName(name))) w.admins.push(name);
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
// ---------- notifications (the top notification bar) ----------
function sendNotif(target, payload) { toPlayer(target, 'notif', payload); }
function worldNotif(worldName, payload) {
  for (const p of players.values()) if (p.world === worldName && p.name) sendNotif(p, payload);
}
function globalNotif(payload) {
  for (const p of players.values()) if (p.name) sendNotif(p, payload);
}

function onChat(p, msg) {
  if (!p.world) return;
  const text = String(msg.text || '').slice(0, 120);
  if (!text) return;
  if (text[0] === '/') {                      // slash command
    const parts = text.slice(1).split(/\s+/);
    return runCommand(p, (parts.shift() || '').toLowerCase(), parts.join(' ').trim());
  }
  // world speech -> notification bar + a speech bubble over the speaker's head
  worldNotif(p.world, { kind: 'world', name: p.name, dev: isDeveloper(p), text });
  broadcast(p.world, 'speech', { id: p.id, text });   // includes the sender
}

function onBroadcast(p, msg) {
  const text = String(msg.text || '').slice(0, 120).trim();
  if (!text || !p.name) return;
  const online = [...players.values()].filter((pl) => pl.name && pl !== p);
  // shuffle and take up to (REACH-1) others, always include the sender
  for (let i = online.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [online[i], online[j]] = [online[j], online[i]]; }
  const recipients = [p, ...online.slice(0, BROADCAST_REACH - 1)];
  const payload = { kind: 'broadcast', name: p.name, dev: isDeveloper(p), text };
  for (const pl of recipients) sendNotif(pl, payload);
}

function onSuperBroadcast(p, msg) {
  const text = String(msg.text || '').slice(0, 120).trim();
  if (!text || !p.name) return;
  const now = Date.now();
  if (!isDeveloper(p)) {
    if (p.superAt && now - p.superAt < SUPER_COOLDOWN) {
      const mins = Math.ceil((SUPER_COOLDOWN - (now - p.superAt)) / 60000);
      return toPlayer(p, 'notify', { text: `SuperBroadcast is on cooldown (${mins} min left).` });
    }
    if (!canAffordGems(p, SUPER_COST)) return toPlayer(p, 'notify', { text: `SuperBroadcast costs ${SUPER_COST} gems.` });
    spendGems(p, SUPER_COST);
    sendInventory(p);
  }
  p.superAt = now;
  globalNotif({ kind: 'super', name: p.name, dev: isDeveloper(p), text, beep: true });
}

// Wrench actions send the same commands the chat slash-commands run.
function onCommand(p, msg) {
  runCommand(p, String(msg.cmd || '').toLowerCase(), String(msg.arg || '').trim());
}

// ---------- moderation commands ----------
// Grouped by required scope so new commands are easy to add later:
//   'owner' = current world's owner (or any developer)
//   'dev'   = developers only
const COMMANDS = {
  ban:        { scope: 'owner', run: (p, name) => cmdWorldBan(p, name, WORLD_BAN_MS) },
  uba:        { scope: 'owner', run: (p, name) => cmdWorldUnban(p, name) },
  kick:       { scope: 'owner', run: (p, name) => cmdKick(p, name) },
  pull:       { scope: 'owner', run: (p, name) => cmdPull(p, name) },
  gameban:    { scope: 'dev',   run: (p, name) => cmdGameBan(p, name) },
  gameunban:  { scope: 'dev',   run: (p, name) => cmdGameUnban(p, name) },
  worldban:   { scope: 'dev',   run: (p, name) => cmdWorldBan(p, name, Infinity) },
  deleteworld:{ scope: 'dev',   run: (p) => cmdDeleteWorld(p) },
  studiokey:  { scope: 'dev',   run: (p) => cmdStudioKey(p) },
};

// Reveal the Sprite Studio key to a developer so they (or a collaborator) can
// log into /studio and edit game assets.
function cmdStudioKey(p) {
  toPlayer(p, 'notify', { text: `Sprite Studio key: ${studioKey}` });
  worldNotif(p.world, { kind: 'event', text: `Studio: open /studio and enter key ${studioKey}` });
}

function isWorldOwner(p) {
  const w = worlds.get(p.world);
  return !!(w && w.owner && normalizeAccountName(w.owner) === normalizeAccountName(p.name));
}
function runCommand(p, cmd, arg) {
  const c = COMMANDS[cmd];
  if (!c) return toPlayer(p, 'notify', { text: `Unknown command: /${cmd}` });
  if (c.scope === 'dev' && !isDeveloper(p)) return toPlayer(p, 'notify', { text: 'Only developers can use that.' });
  if (c.scope === 'owner' && !(isDeveloper(p) || isWorldOwner(p))) {
    return toPlayer(p, 'notify', { text: 'Only the world owner can use that.' });
  }
  c.run(p, arg);
}

function findPlayerByName(name) {
  const lower = normalizeAccountName(name);
  if (!lower) return null;
  return [...players.values()].find((pl) => pl.name && normalizeAccountName(pl.name) === lower) || null;
}

// remaining ban time (ms) for a name in world w; Infinity if permanent, 0 if none
function worldBanRemaining(w, name) {
  if (!w || !w.bans) return 0;
  const key = normalizeAccountName(name);
  const exp = w.bans[key];
  if (exp == null) return 0;
  if (exp === true || exp === Infinity) return Infinity;
  const left = exp - Date.now();
  if (left <= 0) { delete w.bans[key]; return 0; }
  return left;
}

// remove a player from their world and bounce them to the world-select screen
function forceLeaveWorld(target, reason) {
  const wn = target.world;
  if (!wn) return;
  broadcast(wn, 'playerLeave', { id: target.id });
  if (target.trade) cancelTrade(target, 'Trade cancelled.');
  target.world = null;
  toPlayer(target, 'kickedFromWorld', { reason });
}

function cmdWorldBan(p, name, durationMs) {
  const w = worlds.get(p.world); if (!w) return;
  const target = findPlayerByName(name);
  const targetName = target ? target.name : name;
  if (!targetName) return;
  if (isDeveloperName(targetName)) return toPlayer(p, 'notify', { text: 'You cannot ban a developer.' });
  if (normalizeAccountName(targetName) === normalizeAccountName(p.name)) return toPlayer(p, 'notify', { text: "You can't ban yourself." });
  w.bans = w.bans || {};
  w.bans[normalizeAccountName(targetName)] = durationMs === Infinity ? true : Date.now() + durationMs;
  scheduleSave(p.world);
  worldNotif(w.name, { kind: 'event', text: `${targetName} has been banned from ${w.name}` });
  if (target && target.world === p.world) forceLeaveWorld(target, `You were banned from ${w.name}.`);
  toPlayer(p, 'notify', { text: durationMs === Infinity ? `${targetName} is permanently banned from ${w.name}.` : `${targetName} is banned from ${w.name} for 30 min.` });
}
function cmdWorldUnban(p, name) {
  const w = worlds.get(p.world); if (!w || !w.bans) return;
  const key = normalizeAccountName(name);
  if (w.bans[key] == null) return toPlayer(p, 'notify', { text: `${name} is not banned here.` });
  delete w.bans[key];
  scheduleSave(p.world);
  toPlayer(p, 'notify', { text: `Unbanned ${name} from ${w.name}.` });
}
function cmdKick(p, name) {
  const w = worlds.get(p.world); if (!w) return;
  const target = findPlayerByName(name);
  if (!target || target.world !== p.world) return toPlayer(p, 'notify', { text: `${name} is not in this world.` });
  if (isDeveloper(target)) return toPlayer(p, 'notify', { text: 'You cannot kick a developer.' });
  const sp = w.spawnPixel();
  target.x = sp.x; target.y = sp.y; target.vx = 0; target.vy = 0;
  toPlayer(target, 'respawnAt', { x: sp.x, y: sp.y });
  toPlayer(target, 'notify', { text: 'You were sent back to spawn.' });
  broadcast(p.world, 'playerMove', publicPlayer(target), target.id);
  worldNotif(p.world, { kind: 'event', text: `${target.name} has been kicked` });
  toPlayer(p, 'notify', { text: `Kicked ${target.name} to spawn.` });
}
function cmdPull(p, name) {
  const target = findPlayerByName(name);
  if (!target || target.world !== p.world) return toPlayer(p, 'notify', { text: `${name} is not in this world.` });
  if (isDeveloper(target)) return toPlayer(p, 'notify', { text: 'You cannot pull a developer.' });
  target.x = p.x; target.y = p.y; target.vx = 0; target.vy = 0;
  toPlayer(target, 'respawnAt', { x: p.x, y: p.y });
  toPlayer(target, 'notify', { text: `${p.name} pulled you.` });
  broadcast(p.world, 'playerMove', publicPlayer(target), target.id);
  worldNotif(p.world, { kind: 'event', text: `${p.name} pulled ${target.name}` });
  toPlayer(p, 'notify', { text: `Pulled ${target.name} to you.` });
}
function cmdGameBan(p, name) {
  const target = findPlayerByName(name);
  const targetName = target ? target.name : name;
  if (!targetName) return;
  if (isDeveloperName(targetName)) return toPlayer(p, 'notify', { text: 'You cannot ban a developer.' });
  gameBans.add(normalizeAccountName(targetName));
  saveGameBans();
  globalNotif({ kind: 'event', text: `${targetName} has been nuked by the Ancient Gods` });
  if (target) {
    if (target.world) forceLeaveWorld(target, 'You were banned from TreeTopia.');
    toPlayer(target, 'gameBanned', { reason: 'You have been banned from TreeTopia.' });
    setTimeout(() => { try { target.ws.close(); } catch { /* already closed */ } }, 150);
  }
  toPlayer(p, 'notify', { text: `Game-banned ${targetName}.` });
}
function cmdGameUnban(p, name) {
  const key = normalizeAccountName(name);
  if (!gameBans.has(key)) return toPlayer(p, 'notify', { text: `${name} is not game-banned.` });
  gameBans.delete(key);
  saveGameBans();
  toPlayer(p, 'notify', { text: `Game-unbanned ${name}.` });
}
// /deleteworld [NAME] — with no name, deletes the world you're in
function cmdDeleteWorld(p, arg) {
  const name = (arg ? arg : p.world || '').toUpperCase();
  if (!name) return;
  deleteWorldByName(name);
  toPlayer(p, 'notify', { text: `Deleted world ${name}.` });
  if (!p.world) onGetWorlds(p);   // refresh the list if deleted from world-select
}

// delete a world: bounce everyone out, drop its owner claim, wipe file + memory
function deleteWorldByName(rawName) {
  const name = String(rawName || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 18).toUpperCase();
  if (!name) return false;
  const w = worlds.get(name);
  for (const pl of [...players.values()]) {
    if (pl.world === name) forceLeaveWorld(pl, `World ${name} was deleted by a developer.`);
  }
  const ownerName = w ? w.owner : peekOwner(name);
  if (ownerName) removeOwnedWorld(ownerName, name);
  worlds.delete(name);
  dirtyWorlds.delete(name);
  try { fs.unlinkSync(path.join(WORLDS_DIR, name + '.json')); } catch { /* never saved */ }
  return true;
}

// delete any world by name (e.g. from the world-select screen) — developers only
function onDeleteWorld(p, msg) {
  if (!isDeveloper(p)) return toPlayer(p, 'notify', { text: 'Only developers can delete worlds.' });
  const name = String(msg.name || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 18).toUpperCase();
  if (!name) return;
  deleteWorldByName(name);
  toPlayer(p, 'notify', { text: `Deleted world ${name}.` });
  onGetWorlds(p);
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
    const item = ITEMS[id];
    if (!item || item.permanent || item.type === 'currency') continue; // tools/currency use their own paths
    const owned = Math.max(0, Math.floor(Number(p.inventory[id]) || 0));
    const requested = Math.max(0, Math.floor(Number(c) || 0));
    const count = Math.min(owned, requested);
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
  toPlayer(p, 'inventory', { inventory: p.inventory, gems: gemBalance(p), equipped: p.equipped || {} });
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
  profiles[p.name] = { gems: p.gems || 0, inventory: p.inventory, achievements: p.achievements || [], ownedWorlds: p.ownedWorlds || [], equipped: p.equipped || {}, friends: p.friends || [], lastSeen: p.lastSeen || Date.now() };
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

initStudio();
server.listen(PORT, HOST, () => {
  console.log(`\n  🌱 Growtopia Clone running:  http://${HOST}:${PORT}`);
  console.log(`  🎨 Sprite Studio:            /studio  (key in-game via /studiokey)\n`);
});
