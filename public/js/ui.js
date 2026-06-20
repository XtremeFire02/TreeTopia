// All DOM-driven UI: HUD, drag-up inventory drawer, searchable shop, trade,
// admin, player profiles (wrench), chat, toasts, account login.
import { ITEMS, shopCatalog, PACKS, SHOP_INDIVIDUAL, PERMANENT, isPlaceable } from './shared/items.js';
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
    this.wireStaticButtons();
    this.wireDrawer();
  }
  setGame(g) { this.game = g; }

  // ---------- icon helper (sprite <img> or emoji) ----------
  icon(id) {
    const url = iconUrl(id);
    if (url) return `<img class="ic-img" src="${url}" alt="" draggable="false">`;
    const e = ITEMS[id] && ITEMS[id].icon;
    return `<span class="ic-emoji">${e || '❔'}</span>`;
  }

  // ---------- helpers ----------
  modalOpen() {
    return !$('modalBackdrop').classList.contains('hidden') || document.activeElement === $('chatInput');
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
    return [...PERMANENT, ...this.placeableItems().slice(0, 9)];
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
      card.innerHTML = `<div class="ic">${this.icon(id)}</div><div class="nm">${it.name}</div><div class="ct">${tag}</div>`;
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
        card.innerHTML = `<div class="ic">📦</div><div class="nm">${pack.name}</div><div class="pr">${pack.price} 💎</div><div class="cat">${contents}</div>`;
        card.onclick = () => this.net.send('buyPack', { packId: pack.id });
        grid.appendChild(card);
      }
    }

    // rare items, still sold individually
    const rares = SHOP_INDIVIDUAL.map((id) => ITEMS[id]).filter((it) => it && it.price != null && matches(it.name));
    if (rares.length) {
      grid.appendChild(this._shopHeader('✨ Rare Items'));
      for (const it of rares) {
        const card = document.createElement('div'); card.className = 'item-card';
        card.innerHTML = `<div class="ic">${this.icon(it.id)}</div><div class="nm">${it.name}</div><div class="pr">${it.price} 💎</div>`;
        card.onclick = () => this.net.send('buy', { itemId: it.id, qty: 1 });
        grid.appendChild(card);
      }
    }

    // when searching, also surface matching items from the wider catalog
    if (q) {
      const shown = new Set(SHOP_INDIVIDUAL);
      const extra = shopCatalog().filter((s) => !shown.has(s.id) && matches(s.name)).slice(0, 60);
      if (extra.length) {
        grid.appendChild(this._shopHeader('🔎 More Items'));
        for (const s of extra) {
          const card = document.createElement('div'); card.className = 'item-card';
          card.innerHTML = `<div class="ic">${this.icon(s.id)}</div><div class="nm">${s.name}</div><div class="pr">${s.price} 💎</div>`;
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
    const isSelf = m.name === me.name;
    const amOwner = !!(this.game.world && this.game.world.owner && this.game.world.owner === me.name);
    const amDev = !!me.dev;
    const canModerate = !!m.online && !isSelf && !m.dev;   // developers can't be targeted
    $('profOwnerActions').classList.toggle('hidden', !((amOwner || amDev) && canModerate));
    $('profDevActions').classList.toggle('hidden', !(amDev && canModerate));

    this.openModal('profileModal');
  }
  sendModAction(cmd) {
    const name = this._profileTargetName;
    if (!name) return;
    this.net.send('command', { cmd, arg: name });
    this.closeModals();
  }

  // ---------- player tag overlay (wrench buttons over players) ----------
  updatePlayerTags(others, camera, active) {
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
      el.style.left = (o.x - camera.x + 26) + 'px';
      el.style.top = (o.y - camera.y - 56) + 'px';
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
      d.innerHTML = `${this.icon(id)} ${ITEMS[id]?.name || id} x${c}`;
      d.title = 'Click to remove';
      d.onclick = () => { delete this.myTradeItems[id]; this.sendOffer(); };
      your.appendChild(d);
    }
    const their = $('theirOffer'); their.innerHTML = '';
    for (const [id, c] of Object.entries(m.theirItems)) {
      const d = document.createElement('div'); d.className = 'ti';
      d.innerHTML = `${this.icon(id)} ${ITEMS[id]?.name || id} x${c}`;
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

  // ---------- chat ----------
  addChat(name, text, sys = false, dev = false) {
    const log = $('chatLog');
    const d = document.createElement('div');
    if (sys) d.innerHTML = `<span class="sys">${text}</span>`;
    else {
      const label = dev && !String(name).startsWith('@') ? '@' + name : name;
      const nameClass = dev ? 'cname dev-name' : 'cname';
      d.innerHTML = `<span class="${nameClass}">${escapeHtml(label)}:</span> ${escapeHtml(text)}`;
    }
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    while (log.children.length > 40) log.removeChild(log.firstChild);
  }
  focusChat() { setTyping(true); $('chatInput').focus(); }

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
    this.openModal('devModal');
  }
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
    $('shopBtn').onclick = () => { this.renderShop(); this.openModal('shopModal'); };
    $('adminBtn').onclick = () => { this.renderAdmin(); this.openModal('adminModal'); };
    $('devBtn').onclick = () => this.openDevPanel();
    $('grantDevBtn').onclick = () => {
      const name = $('devNameInput').value.trim();
      if (name) { this.net.send('setDeveloper', { name, grant: true }); $('devNameInput').value = ''; }
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

    const ci = $('chatInput');
    const sendChat = (keepFocus) => {
      const t = ci.value.trim();
      if (t) this.net.send('chat', { text: t });
      ci.value = '';
      if (!keepFocus) { ci.blur(); setTyping(false); }
    };
    ci.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') sendChat(false);
      else if (e.key === 'Escape') { ci.value = ''; ci.blur(); setTyping(false); }
    });
    ci.addEventListener('focus', () => setTyping(true));   // mobile: tapping the box = chatting
    ci.addEventListener('blur', () => setTyping(false));
    // explicit Send button — the reliable way to send on mobile (no Enter key)
    $('chatSend').addEventListener('click', () => sendChat(true));
  }
}

function formatGems(gems) {
  return Number(gems) >= Number.MAX_SAFE_INTEGER ? '∞' : gems;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Fire `fn` on a double click / double tap of `el` (works for mouse and touch).
function onDoubleTap(el, fn) {
  let last = 0;
  el.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - last < 320) { last = 0; e.preventDefault(); fn(); }
    else last = now;
  });
}
