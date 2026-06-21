// All DOM-driven UI: HUD, drag-up inventory drawer, searchable shop, trade,
// admin, player profiles (wrench), chat, toasts, account login.
import { ITEMS, shopCatalog, PACKS, SHOP_INDIVIDUAL, PERMANENT, isPlaceable } from './shared/items.js';
import { CUSTOM_ITEMS } from './shared/custom-items.js';
import { loadCustomItems } from './custom.js';
import { iconUrl } from './assets.js';
import { setTyping } from './input.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(net) {
    this.net = net;
    this.game = null;
    this.trade = null;
    this.myTradeItems = {};
    this._tagEls = {};
    this._profileTargetId = null;
    this._notifs = [];
    this.wireStaticButtons();
    this.wireDrawer();
    this.wireNotifBar();
  }
  setGame(g) { this.game = g; }

  // ---------- icon helper (sprite <img> or emoji) ----------
  icon(id) {
    const url = iconUrl(id);
    if (url) return `<img class="ic-img" src="${escapeHtml(url)}" alt="" draggable="false">`;
    const e = ITEMS[id] && ITEMS[id].icon;
    return `<span class="ic-emoji">${escapeHtml(e || '❔')}</span>`;
  }

  // ---------- helpers ----------
  modalOpen() {
    return !$('modalBackdrop').classList.contains('hidden');
  }
  openModal(id) {
    $('modalBackdrop').classList.remove('hidden');
    for (const m of $('modalBackdrop').children) m.classList.add('hidden');
    $(id).classList.remove('hidden');
  }
  closeModals() {
    $('modalBackdrop').classList.add('hidden');
    for (const m of $('modalBackdrop').children) m.classList.add('hidden');
  }
  toast(text) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }
  showDeath(on) { $('deathOverlay').classList.toggle('hidden', !on); }
  showAuthError(text) { const e = $('authError'); e.textContent = text; e.classList.remove('hidden'); }

  // ---------- entering a world ----------
  onEnterWorld(world, ownerDev = false) {
    $('worldLabel').textContent = world.name;
    const ownerLabel = $('ownerLabel');
    const ownerName = ownerDev && world.owner && !world.owner.startsWith('@') ? '@' + world.owner : world.owner;
    ownerLabel.textContent = world.owner ? `Owner: ${ownerName}` : 'Public world';
    ownerLabel.classList.toggle('dev-name', !!ownerDev);
    const mine = world.owner && world.owner === this.game.me.name;
    $('adminBtn').classList.toggle('hidden', !mine);
    this.onInventory();
  }

  // ---------- inventory / gems ----------
  onInventory() {
    $('gemCount').textContent = formatGems(this.game.me.gems);
    $('shopGems').textContent = formatGems(this.game.me.gems);
    this.buildHotbar();
    this.renderInventory();
    if (!$('tradeModal').classList.contains('hidden')) this.refreshTradeSelects();
  }

  // ---------- hotbar ----------
  placeableItems() {
    return Object.keys(this.game.me.inventory)
      .filter((id) => this.game.me.inventory[id] > 0 && isPlaceable(id));
  }
  hotbarItems() {
    const base = [...PERMANENT, ...this.placeableItems().slice(0, 9)];
    // Always keep the currently-selected item usable, even if it's past the
    // first 9 placeables — otherwise picking it from the inventory would snap
    // the selection back to the fist and the item couldn't be placed.
    const sel = this.game.selected;
    if (sel && !base.includes(sel) && (PERMANENT.includes(sel) || this.placeableItems().includes(sel))) {
      base.push(sel);
    }
    return base;
  }
  buildHotbar() {
    const bar = $('hotbar'); bar.innerHTML = '';
    const items = this.hotbarItems();
    if (!this.game.selected || !items.includes(this.game.selected)) this.game.selected = 'fist';
    items.forEach((id, idx) => {
      const it = ITEMS[id]; if (!it) return;
      const perm = !!it.permanent;
      const cnt = this.game.me.inventory[id] || 0;
      const slot = document.createElement('div');
      slot.className = 'slot' + (this.game.selected === id ? ' active' : '') + (perm ? ' permanent' : '');
      slot.innerHTML = `<span class="key">${idx + 1}</span>${this.icon(id)}` + (perm ? '' : `<span class="count">${cnt}</span>`);
      slot.title = it.name;
      slot.onclick = () => { this.game.selected = id; this.buildHotbar(); };
      bar.appendChild(slot);
    });
  }
  selectSlot(n) { const items = this.hotbarItems(); if (items[n - 1]) { this.game.selected = items[n - 1]; this.buildHotbar(); } }

  // ---------- inventory grid (inside drawer) ----------
  renderInventory() {
    const grid = $('inventoryGrid'); grid.innerHTML = '';
    const inv = this.game.me.inventory;
    const ids = Object.keys(inv).filter((id) => inv[id] > 0);
    ids.sort((a, b) => (ITEMS[b]?.permanent ? 1 : 0) - (ITEMS[a]?.permanent ? 1 : 0));
    for (const id of ids) {
      const it = ITEMS[id]; if (!it) continue;
      const clothing = it.type === 'clothing';
      const slot = it.slot || 'body';
      const worn = clothing && this.game.me.equipped && this.game.me.equipped[slot] === id;
      const card = document.createElement('div');
      card.className = 'item-card' + (this.game.selected === id ? ' active' : '') + (worn ? ' worn' : '');
      const tag = it.permanent ? 'tool' : (clothing ? (worn ? '✔ worn' : 'double-tap') : 'x' + inv[id]);
      card.innerHTML = `<div class="ic">${this.icon(id)}</div><div class="nm">${escapeHtml(it.name)}</div><div class="ct">${escapeHtml(tag)}</div>`;
      if (clothing) {
        // double-tap (here in the inventory only) equips / unequips clothing
        onDoubleTap(card, () => this.net.send('equip', { itemId: id }));
      } else {
        card.onclick = () => { this.game.selected = id; this.buildHotbar(); this.renderInventory(); };
      }
      grid.appendChild(card);
    }
    // splice selects
    const seeds = ids.filter((id) => ITEMS[id].type === 'seed');
    const fill = (sel) => { sel.innerHTML = ''; seeds.forEach((id) => { const o = document.createElement('option'); o.value = id; o.textContent = `${ITEMS[id].name} (x${inv[id]})`; sel.appendChild(o); }); };
    fill($('spliceA')); fill($('spliceB'));
  }

  // ---------- shop (item packs + rare individuals) ----------
  _shopHeader(text) {
    const h = document.createElement('div'); h.className = 'shop-section'; h.textContent = text; return h;
  }
  renderShop() {
    $('shopGems').textContent = formatGems(this.game.me.gems);
    const q = ($('shopSearch').value || '').toLowerCase().trim();
    const matches = (name) => !q || String(name).toLowerCase().includes(q);
    const grid = $('shopGrid'); grid.innerHTML = '';

    // item packs (bundles of similar items)
    const packs = PACKS.filter((p) => matches(p.name));
    if (packs.length) {
      grid.appendChild(this._shopHeader('📦 Item Packs'));
      for (const pack of packs) {
        const contents = Object.entries(pack.items).map(([id, n]) => `${n}× ${ITEMS[id]?.name || id}`).join(', ');
        const card = document.createElement('div'); card.className = 'item-card pack-card';
        card.title = contents;
        card.innerHTML = `<div class="ic">📦</div><div class="nm">${escapeHtml(pack.name)}</div><div class="pr">${pack.price} 💎</div><div class="cat">${escapeHtml(contents)}</div>`;
        card.onclick = () => this.net.send('buyPack', { packId: pack.id });
        grid.appendChild(card);
      }
    }

    // custom items made in the Sprite Studio that were given a shop price
    const customs = Object.keys(CUSTOM_ITEMS)
      .map((id) => ITEMS[id])
      .filter((it) => it && it.price != null && matches(it.name));
    if (customs.length) {
      grid.appendChild(this._shopHeader('🎨 Custom Items'));
      for (const it of customs) {
        const card = document.createElement('div'); card.className = 'item-card';
        card.innerHTML = `<div class="ic">${this.icon(it.id)}</div><div class="nm">${escapeHtml(it.name)}</div><div class="pr">${it.price} 💎</div>`;
        card.onclick = () => this.net.send('buy', { itemId: it.id, qty: 1 });
        grid.appendChild(card);
      }
    }

    // rare items, still sold individually
    const rares = SHOP_INDIVIDUAL.map((id) => ITEMS[id]).filter((it) => it && it.price != null && matches(it.name));
    if (rares.length) {
      grid.appendChild(this._shopHeader('✨ Rare Items'));
      for (const it of rares) {
        const card = document.createElement('div'); card.className = 'item-card';
        card.innerHTML = `<div class="ic">${this.icon(it.id)}</div><div class="nm">${escapeHtml(it.name)}</div><div class="pr">${it.price} 💎</div>`;
        card.onclick = () => this.net.send('buy', { itemId: it.id, qty: 1 });
        grid.appendChild(card);
      }
    }

    // when searching, also surface matching items from the wider catalog
    if (q) {
      const shown = new Set([...SHOP_INDIVIDUAL, ...Object.keys(CUSTOM_ITEMS)]);
      const extra = shopCatalog().filter((s) => !shown.has(s.id) && matches(s.name)).slice(0, 60);
      if (extra.length) {
        grid.appendChild(this._shopHeader('🔎 More Items'));
        for (const s of extra) {
          const card = document.createElement('div'); card.className = 'item-card';
          card.innerHTML = `<div class="ic">${this.icon(s.id)}</div><div class="nm">${escapeHtml(s.name)}</div><div class="pr">${s.price} 💎</div>`;
          card.onclick = () => this.net.send('buy', { itemId: s.id, qty: 1 });
          grid.appendChild(card);
        }
      }
    }

    $('shopNote').textContent = q ? 'Showing matches for your search.' : 'Buy a pack for a bundle of items, or grab a rare item. Search to find more.';
  }

  // ---------- admin ----------
  renderAdmin() {
    const w = this.game.world;
    $('adminCurrent').textContent = w.admins && w.admins.length ? 'Current admins: ' + w.admins.join(', ') : 'No admins yet.';
  }

  // ---------- player profile (wrench) ----------
  openProfile(id) { this._profileTargetId = id; this.net.send('getProfile', { id }); }
  onProfile(m) {
    const profName = $('profName');
    profName.textContent = m.dev && !String(m.name).startsWith('@') ? '@' + m.name : m.name;
    profName.classList.toggle('dev-name', !!m.dev);
    $('profOnline').textContent = (m.online ? '🟢 Online' : '⚪ Offline') + ` · 💎 ${formatGems(m.gems)}`;
    const fill = (elId, arr, empty) => {
      const ul = $(elId); ul.innerHTML = '';
      if (!arr.length) { ul.innerHTML = `<li class="empty">${empty}</li>`; return; }
      for (const t of arr) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
    };
    fill('profAchievements', m.achievements, 'No achievements yet.');
    fill('profWorlds', m.ownedWorlds, 'Owns no worlds.');
    fill('profEffects', m.effects, 'No active effects.');
    const canTrade = m.online && this._profileTargetId != null && m.name !== this.game.me.name;
    const btn = $('profTradeBtn');
    btn.classList.toggle('hidden', !canTrade);
    btn.onclick = () => { this.net.send('tradeRequest', { targetId: this._profileTargetId }); this.closeModals(); };

    // moderation actions (server still enforces permissions)
    this._profileTargetName = m.name;
    const me = this.game.me;
    const isSelf = m.isSelf || m.name === me.name;
    const amOwner = !!(this.game.world && this.game.world.owner && this.game.world.owner === me.name);
    const amDev = !!me.dev;
    const canModerate = !!m.online && !isSelf && !m.dev;   // developers can't be targeted
    $('profOwnerActions').classList.toggle('hidden', !((amOwner || amDev) && canModerate));
    $('profDevActions').classList.toggle('hidden', !(amDev && canModerate));

    // friend controls
    const fbox = $('profFriendBox');
    fbox.classList.toggle('hidden', isSelf);
    if (!isSelf) {
      const addBtn = $('profAddFriendBtn'), warpBtn = $('profWarpBtn'), last = $('profLastSeen');
      addBtn.textContent = m.added ? '➖ Remove Friend' : '➕ Add Friend';
      addBtn.onclick = () => {
        this.net.send(m.added ? 'removeFriend' : 'addFriend', { name: m.name });
        this.closeModals();
      };
      // last login is only sent for mutual friends
      last.textContent = m.friend
        ? (m.online ? '🟢 Online now' : (m.lastSeen ? 'Last login: ' + timeAgo(m.lastSeen) : 'Last login: unknown'))
        : (m.added ? 'Pending — they need to add you back to become friends.' : 'Add as a friend to see their last login and warp to them.');
      const canWarp = m.friend && m.online && m.world;
      warpBtn.classList.toggle('hidden', !canWarp);
      warpBtn.textContent = canWarp ? `🌀 Warp to ${m.world}` : '🌀 Warp to world';
      warpBtn.onclick = () => { this.net.send('warpToFriend', { name: m.name }); this.closeModals(); };
    }

    this.openModal('profileModal');
  }

  // ---------- friends list ----------
  openFriends() { this.net.send('getFriends'); this.openModal('friendsModal'); }
  onFriends(list) {
    const box = $('friendsList'); if (!box) return;
    box.innerHTML = '';
    if (!list || !list.length) { box.innerHTML = '<div class="hint">No friends yet. Wrench a player and tap “Add Friend”.</div>'; return; }
    // mutual friends first, then by name
    list.sort((a, b) => Number(b.mutual) - Number(a.mutual) || a.name.localeCompare(b.name));
    for (const f of list) {
      const row = document.createElement('div'); row.className = 'friend-row';
      const status = f.online ? '🟢 Online' + (f.world ? ` · in ${f.world}` : '') : (f.lastSeen ? '⚪ ' + timeAgo(f.lastSeen) : '⚪ Offline');
      const tag = f.mutual ? '' : ' <span class="pending">pending</span>';
      row.innerHTML = `<div class="fr-main"><span class="fr-name ${f.dev ? 'dev-name' : ''}">${escapeHtml((f.dev && !f.name.startsWith('@') ? '@' : '') + f.name)}</span>${tag}<div class="fr-status">${status}</div></div>`;
      const acts = document.createElement('div'); acts.className = 'fr-acts';
      if (f.mutual && f.online && f.world) {
        const warp = document.createElement('button'); warp.className = 'ghost-btn'; warp.textContent = '🌀 Warp';
        warp.onclick = () => { this.net.send('warpToFriend', { name: f.name }); this.closeModals(); };
        acts.appendChild(warp);
      }
      const rm = document.createElement('button'); rm.className = 'ghost-btn'; rm.textContent = '✕';
      rm.title = 'Remove friend'; rm.onclick = () => this.net.send('removeFriend', { name: f.name });
      acts.appendChild(rm);
      row.appendChild(acts); box.appendChild(row);
    }
  }
  sendModAction(cmd) {
    const name = this._profileTargetName;
    if (!name) return;
    this.net.send('command', { cmd, arg: name });
    this.closeModals();
  }

  // ---------- player tag overlay (wrench buttons over players) ----------
  updatePlayerTags(others, camera, active, zoom = 1) {
    const layer = $('playerTags');
    if (!active) { if (layer.childElementCount) { layer.innerHTML = ''; this._tagEls = {}; } return; }
    const seen = new Set();
    for (const o of others) {
      seen.add(o.id);
      let el = this._tagEls[o.id];
      if (!el) {
        el = document.createElement('div'); el.className = 'ptag';
        const b = document.createElement('button'); b.className = 'wbtn'; b.textContent = '🔧'; b.title = 'Inspect ' + o.name;
        b.onclick = () => this.openProfile(o.id);
        el.appendChild(b); layer.appendChild(el); this._tagEls[o.id] = el;
      }
      // world position -> screen pixels (account for the zoom transform)
      el.style.left = ((o.x - camera.x) * zoom + 16) + 'px';
      el.style.top = ((o.y - camera.y) * zoom - 26 * zoom) + 'px';
    }
    for (const id in this._tagEls) if (!seen.has(Number(id))) { this._tagEls[id].remove(); delete this._tagEls[id]; }
  }

  // ---------- trade ----------
  onTradeRequest(fromId, fromName) {
    this._pendingFrom = fromId;
    $('tradePromptText').textContent = `${fromName} wants to trade with you.`;
    this.openModal('tradePrompt');
  }
  onTradeWindow(m) {
    this.trade = m;
    this.myTradeItems = { ...m.yourItems };
    $('tradePartner').textContent = m.partnerName;
    this.openModal('tradeModal');
    this.renderTrade();
  }
  renderTrade() {
    const m = this.trade; if (!m) return;
    const your = $('yourOffer'); your.innerHTML = '';
    for (const [id, c] of Object.entries(m.yourItems)) {
      const d = document.createElement('div'); d.className = 'ti';
      d.innerHTML = `${this.icon(id)} ${escapeHtml(ITEMS[id]?.name || id)} x${c}`;
      d.title = 'Click to remove';
      d.onclick = () => { delete this.myTradeItems[id]; this.sendOffer(); };
      your.appendChild(d);
    }
    const their = $('theirOffer'); their.innerHTML = '';
    for (const [id, c] of Object.entries(m.theirItems)) {
      const d = document.createElement('div'); d.className = 'ti';
      d.innerHTML = `${this.icon(id)} ${escapeHtml(ITEMS[id]?.name || id)} x${c}`;
      their.appendChild(d);
    }
    $('theirTradeGems').textContent = formatGems(m.theirGems);
    $('yourConfirmTag').classList.toggle('hidden', !m.youConfirmed);
    $('theirConfirmTag').classList.toggle('hidden', !m.theyConfirmed);
    this.refreshTradeSelects();
  }
  refreshTradeSelects() {
    const sel = $('yourInvSelect'); if (!sel) return;
    const inv = this.game.me.inventory; sel.innerHTML = '';
    for (const id of Object.keys(inv)) {
      if (!ITEMS[id] || ITEMS[id].type === 'currency' || ITEMS[id].permanent) continue;
      const o = document.createElement('option'); o.value = id;
      o.textContent = `${ITEMS[id].name} (x${inv[id]})`; sel.appendChild(o);
    }
  }
  sendOffer() {
    const gems = Math.max(0, parseInt($('yourTradeGems').value) || 0);
    this.net.send('tradeOffer', { items: this.myTradeItems, gems });
  }
  onTradeDone() { this.trade = null; this.myTradeItems = {}; this.closeModals(); }

  // ---------- notifications (the top bar) ----------
  // Persist across worlds; cleared only on a fresh login (see clearNotifs()).
  clearNotifs() { this._notifs = []; this.renderNotifs(); }
  addNotif(m) {
    if (!this._notifs) this._notifs = [];
    const label = (n) => (m.dev && !String(n).startsWith('@') ? '@' + n : n);
    let cls = 'notif ' + (m.kind || 'event');
    let html;
    if (m.kind === 'world') html = `<span class="who ${m.dev ? 'dev-name' : ''}">(${escapeHtml(label(m.name))})</span>: ${escapeHtml(m.text)}`;
    else if (m.kind === 'broadcast') html = `<span class="tag">Broadcast</span> <span class="who ${m.dev ? 'dev-name' : ''}">(${escapeHtml(label(m.name))})</span>: ${escapeHtml(m.text)}`;
    else if (m.kind === 'super') html = `<span class="tag">SuperBroadcast</span> <span class="who ${m.dev ? 'dev-name' : ''}">(${escapeHtml(label(m.name))})</span>: ${escapeHtml(m.text)}`;
    else html = escapeHtml(m.text);
    this._notifs.unshift({ cls, html });        // newest first
    if (this._notifs.length > 80) this._notifs.length = 80;
    this.renderNotifs();
    if (m.beep) this.playBeep();
  }
  renderNotifs() {
    const box = $('notifScroll'); if (!box) return;
    box.innerHTML = '';
    if (!this._notifs || !this._notifs.length) { box.innerHTML = '<div class="notif-empty">No messages yet.</div>'; return; }
    for (const n of this._notifs) {
      const d = document.createElement('div'); d.className = n.cls; d.innerHTML = n.html;
      box.appendChild(d);
    }
  }
  playBeep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!this._audio) this._audio = new AC();
      const ac = this._audio; if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.value = 0.05; o.connect(g); g.connect(ac.destination);
      o.start(); o.frequency.setValueAtTime(660, ac.currentTime + 0.1);
      o.stop(ac.currentTime + 0.2);
    } catch { /* audio not available */ }
  }
  // notification bar: drag the bottom handle DOWN to expand, up to collapse
  wireNotifBar() {
    const bar = $('notifBar'), handle = $('notifHandle');
    if (!bar || !handle) return;
    const MIN = 28, maxH = () => Math.round(window.innerHeight * 0.7);
    let startY = null, startH = 0;
    handle.addEventListener('pointerdown', (e) => {
      startY = e.clientY; startH = bar.getBoundingClientRect().height;
      try { handle.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (startY != null) bar.style.height = Math.max(MIN, Math.min(maxH(), startH + (e.clientY - startY))) + 'px'; });
    const end = () => { startY = null; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  // ---------- broadcasts (📢 Cast modal) ----------
  openCompose() { this.openModal('composeModal'); setTimeout(() => $('composeInput').focus(), 50); }
  sendCompose(mode) {
    const ci = $('composeInput'); const text = ci.value.trim();
    if (!text) return;
    if (mode === 'broadcast') this.net.send('broadcast', { text });
    else if (mode === 'super') this.net.send('superBroadcast', { text });
    ci.value = ''; this.closeModals();
  }
  // ---------- local chat (💬) — live draft notch built into the notification bar ----------
  startChat() {
    this.closeMenu();
    const form = $('chatForm'), cd = $('chatDraft'), bar = $('notifBar');
    form.classList.remove('hidden');
    cd.value = '';
    // grow the bar so the draft + a couple of messages stay visible while typing
    this._notifPrevH = bar.getBoundingClientRect().height;
    const want = Math.min(180, Math.round(window.innerHeight * 0.5));
    if (this._notifPrevH < want) bar.style.height = want + 'px';
    setTyping(true);
    // Focus synchronously inside the tap gesture so mobile keyboards actually open.
    cd.focus();
  }
  sendChat() {
    const cd = $('chatDraft');
    const text = cd.value.trim();
    if (text) this.net.send('chat', { text });   // server posts the notif + a speech bubble
    this.hideChat();                              // Enter sends AND closes the chat + keyboard
  }
  hideChat() {
    const form = $('chatForm');
    if (form.classList.contains('hidden')) return;
    const cd = $('chatDraft'); cd.value = ''; cd.blur();   // blur dismisses the soft keyboard
    form.classList.add('hidden');
    if (this._notifPrevH != null) { $('notifBar').style.height = this._notifPrevH + 'px'; this._notifPrevH = null; }
    setTyping(false);
  }
  focusChat() { this.startChat(); }   // Enter on desktop opens the chat draft

  // ---------- HUD menu (☰) — collapses every right-stack option but the gems chip ----------
  toggleMenu() {
    const menu = $('hudMenu'), btn = $('menuBtn');
    const open = menu.classList.toggle('hidden');
    btn.classList.toggle('open', !open);
  }
  closeMenu() {
    $('hudMenu').classList.add('hidden');
    $('menuBtn').classList.remove('open');
  }

  // ---------- drawer drag (continuous height — drag the notch up/down) ----------
  wireDrawer() {
    const drawer = $('invDrawer'), notch = $('drawerNotch');
    const MIN = 24, maxH = () => Math.round(window.innerHeight * 0.85);
    let startY = null, startH = 0;
    const setH = (h) => { drawer.style.height = Math.max(MIN, Math.min(maxH(), h)) + 'px'; };
    notch.addEventListener('pointerdown', (e) => {
      startY = e.clientY; startH = drawer.getBoundingClientRect().height;
      try { notch.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    notch.addEventListener('pointermove', (e) => { if (startY != null) setH(startH + (startY - e.clientY)); });
    const end = () => { startY = null; };
    notch.addEventListener('pointerup', end);
    notch.addEventListener('pointercancel', end);
    this._setDrawerHeight = setH;
  }
  // keyboard E (desktop): toggle between just-the-hotbar and a tall inventory
  toggleDrawer() {
    const h = $('invDrawer').getBoundingClientRect().height;
    if (this._setDrawerHeight) this._setDrawerHeight(h > 140 ? 94 : Math.round(window.innerHeight * 0.6));
  }

  // ---------- developer status / settings ----------
  onDevStatus() {
    const isDev = !!this.game.me.dev;
    const btn = $('devBtn');
    if (btn) btn.classList.toggle('hidden', !isDev);
    if (!isDev) this._closeIf('devModal');
  }
  _closeIf(id) {
    if (!$(id).classList.contains('hidden')) this.closeModals();
  }
  openDevPanel() {
    if (!this.game.me.dev) return;
    this.net.send('getDevelopers');
    this.renderDevPlayers();
    this.openModal('devModal');
  }
  // list of players in the world, each with the full set of dev actions
  renderDevPlayers() {
    const box = $('devPlayers'); if (!box) return;
    box.innerHTML = '';
    const others = this.game ? [...this.game.others.values()] : [];
    if (!others.length) { box.innerHTML = '<div class="hint">No other players in this world.</div>'; return; }
    for (const o of others) {
      const row = document.createElement('div'); row.className = 'devp-row';
      const nm = document.createElement('span');
      nm.className = 'devp-name' + (o.dev ? ' dev-name' : '');
      nm.textContent = (o.dev ? '@' : '') + o.name;
      const acts = document.createElement('div'); acts.className = 'devp-acts';
      const add = (label, fn) => { const b = document.createElement('button'); b.className = 'ghost-btn'; b.textContent = label; b.onclick = fn; acts.appendChild(b); };
      add('🧲 Pull', () => this.devAct('pull', o.name));
      add('🦵 Kick', () => this.devAct('kick', o.name));
      add('⛔ Ban 30m', () => this.devAct('ban', o.name));
      add('🚫 World Ban', () => this.devAct('worldban', o.name));
      add('🔨 Game Ban', () => this.devAct('gameban', o.name));
      add(o.dev ? '➖ Dev' : '➕ Dev', () => { this.net.send('setDeveloper', { name: o.name, grant: !o.dev }); });
      row.appendChild(nm); row.appendChild(acts); box.appendChild(row);
    }
  }
  devAct(cmd, name) { this.net.send('command', { cmd, arg: name }); }
  onDevList(list) {
    const box = $('devList'); if (!box) return;
    box.innerHTML = '';
    const others = (list || []).filter((n) => n !== '@xtremefire');
    if (!others.length) { box.innerHTML = '<div class="hint">No granted developers yet.</div>'; return; }
    for (const name of others) {
      const row = document.createElement('div'); row.className = 'dev-row';
      row.innerHTML = `<span>@${escapeHtml(name)}</span>`;
      const btn = document.createElement('button'); btn.className = 'ghost-btn'; btn.textContent = 'Remove';
      btn.onclick = () => this.net.send('setDeveloper', { name, grant: false });
      row.appendChild(btn); box.appendChild(row);
    }
  }

  // ---------- static buttons ----------
  wireStaticButtons() {
    $('friendsBtn').onclick = () => this.openFriends();
    $('addFriendByNameBtn').onclick = () => {
      const name = $('friendNameInput').value.trim();
      if (name) { this.net.send('addFriend', { name }); $('friendNameInput').value = ''; }
    };
    $('shopBtn').onclick = async () => {
      this.renderShop(); this.openModal('shopModal');
      await loadCustomItems();   // pick up items saved in the studio since boot
      this.renderShop();
    };
    $('adminBtn').onclick = () => { this.renderAdmin(); this.openModal('adminModal'); };
    $('devBtn').onclick = () => this.openDevPanel();
    $('grantDevBtn').onclick = () => {
      const name = $('devNameInput').value.trim();
      if (name) { this.net.send('setDeveloper', { name, grant: true }); $('devNameInput').value = ''; }
    };
    $('delWorldBtn').onclick = () => {
      const wn = this.game.world && this.game.world.name;
      if (wn && window.confirm(`Delete world ${wn}? Everyone will be sent out and the world is wiped.`)) {
        this.net.send('command', { cmd: 'deleteworld', arg: '' });
        this.closeModals();
      }
    };
    $('exitBtn').onclick = () => { this.game.stop(); this.net.send('leaveWorld'); document.dispatchEvent(new Event('backToWorlds')); };

    for (const x of document.querySelectorAll('[data-act]')) x.onclick = () => this.sendModAction(x.dataset.act);

    for (const x of document.querySelectorAll('[data-close]')) x.onclick = () => this.closeModals();
    for (const x of document.querySelectorAll('[data-close-trade]')) x.onclick = () => { this.net.send('tradeCancel'); this.closeModals(); };

    $('shopSearch').addEventListener('input', () => this.renderShop());
    $('shopCategory').addEventListener('change', () => this.renderShop());

    $('spliceBtn').onclick = () => { const a = $('spliceA').value, b = $('spliceB').value; if (a && b) this.net.send('splice', { a, b }); };
    $('addAdminBtn').onclick = () => { const name = $('adminNameInput').value.trim(); if (name) { this.net.send('addAdmin', { name }); $('adminNameInput').value = ''; } };

    $('addTradeItem').onclick = () => {
      const id = $('yourInvSelect').value;
      const qty = Math.max(1, parseInt($('yourAddQty').value) || 1);
      if (!id) return;
      this.myTradeItems[id] = (this.myTradeItems[id] || 0) + qty;
      this.sendOffer();
    };
    $('yourTradeGems').onchange = () => this.sendOffer();
    $('tradeConfirmBtn').onclick = () => this.net.send('tradeConfirm');
    $('tradeCancelBtn').onclick = () => { this.net.send('tradeCancel'); this.closeModals(); };
    $('acceptTradeBtn').onclick = () => { this.net.send('tradeAccept', { fromId: this._pendingFrom }); this.closeModals(); };
    $('declineTradeBtn').onclick = () => this.closeModals();

    // collapsible HUD menu (☰): keep only the gems chip + ☰ on screen
    $('menuBtn').onclick = () => this.toggleMenu();
    $('hudMenu').addEventListener('click', (e) => { if (e.target.closest('.hud-btn')) this.closeMenu(); });

    // local chat (💬) + broadcasts (📢 Cast)
    $('chatBtn').onclick = () => this.startChat();
    $('sayBtn').onclick = () => this.openCompose();
    $('broadcastBtn').onclick = () => this.sendCompose('broadcast');
    $('superBtn').onclick = () => this.sendCompose('super');
    const ci = $('composeInput');
    ci.addEventListener('focus', () => setTyping(true));
    ci.addEventListener('blur', () => setTyping(false));
    ci.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.closeModals(); });
    // live chat-draft notch — a real <form> so the mobile keyboard's Go/Return reliably submits
    const cd = $('chatDraft');
    $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); this.sendChat(); });
    cd.addEventListener('focus', () => { clearTimeout(this._blurHide); setTyping(true); });
    cd.addEventListener('blur', () => {
      setTyping(false);
      // dismissing the keyboard with nothing typed closes the notch (no Esc key on mobile)
      this._blurHide = setTimeout(() => { if (!cd.value.trim()) this.hideChat(); }, 200);
    });
    cd.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.hideChat();
    });
  }
}

function formatGems(gems) {
  return Number(gems) >= Number.MAX_SAFE_INTEGER ? '∞' : gems;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// human-readable "time since" for friend last-login ("5m ago", "2h ago", "3d ago")
function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

// Fire `fn` on a double click / double tap of `el` (works for mouse and touch).
function onDoubleTap(el, fn) {
  let last = 0;
  el.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - last < 320) { last = 0; e.preventDefault(); fn(); }
    else last = now;
  });
}
