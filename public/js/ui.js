// All DOM-driven UI: HUD, drag-up inventory drawer, searchable shop, trade,
// admin, player profiles (wrench), chat, toasts, account login.
import { ITEMS, shopCatalog, categories, PERMANENT, isPlaceable } from './shared/items.js';
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

  // ---------- shop (searchable / categorized) ----------
  ensureShopCategories() {
    const sel = $('shopCategory');
    if (sel.dataset.ready) return;
    sel.innerHTML = '<option value="All">All categories</option>';
    for (const c of categories()) { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
    sel.dataset.ready = '1';
  }
  renderShop() {
    this.ensureShopCategories();
    $('shopGems').textContent = formatGems(this.game.me.gems);
    const q = ($('shopSearch').value || '').toLowerCase().trim();
    const cat = $('shopCategory').value || 'All';
    let list = shopCatalog().filter((s) => (cat === 'All' || s.category === cat) && (!q || s.name.toLowerCase().includes(q)));
    const total = list.length;
    list = list.slice(0, 150);
    const grid = $('shopGrid'); grid.innerHTML = '';
    for (const s of list) {
      const card = document.createElement('div'); card.className = 'item-card';
      card.innerHTML = `<div class="ic">${this.icon(s.id)}</div><div class="nm">${s.name}</div><div class="pr">${s.price} 💎</div><div class="cat">${s.category}</div>`;
      card.onclick = () => this.net.send('buy', { itemId: s.id, qty: 1 });
      grid.appendChild(card);
    }
    $('shopNote').textContent = total > list.length ? `Showing ${list.length} of ${total} — refine your search.` : `${total} item(s).`;
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
    this.openModal('profileModal');
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
    ci.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = ci.value.trim(); if (t) this.net.send('chat', { text: t }); ci.value = ''; ci.blur(); setTyping(false); }
      else if (e.key === 'Escape') { ci.value = ''; ci.blur(); setTyping(false); }
    });
    ci.addEventListener('blur', () => setTyping(false));
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
