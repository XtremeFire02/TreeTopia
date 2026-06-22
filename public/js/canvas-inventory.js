import { ITEMS, PERMANENT, isClothing, isPlaceable } from './shared/items.js';
import { tileSprite } from './assets.js';

const HOTBAR_LIMIT = 5;
const BG_W = 1024;
const BG_H = 1536;
const COLLAPSED_SRC_H = 222;

const uiImages = {
  inventory: loadImage('assets/ui/InventoryBackground.png'),
};

export class CanvasInventory {
  constructor(ui) {
    this.ui = ui;
    this.game = null;
    this.drawerVisibleHeight = null;
    this.collapsedHeight = 0;
    this.maxDrawerHeight = 0;
    this.seedSlots = [null, null];
    this.activeSeedSlot = 0;
    this.inventoryScroll = 0;
    this.maxScroll = 0;
    this.pointer = { x: -1, y: -1 };
    this.hit = emptyHit();
    this._lastTap = { id: null, t: 0 };
    this._suppressMouseUntil = 0;
    this._dragScroll = null;
    this._dragDrawer = null;
  }

  setGame(game) {
    this.game = game;
    this._wireCanvas();
  }

  onInventory() {
    if (!this.game) return;
    this._ensureSelected();
    this._ensureSeedSlots();
  }

  toggle() {
    this._syncDrawerMetrics();
    const target = this._isExpanded() ? this.collapsedHeight : this.maxDrawerHeight;
    this.drawerVisibleHeight = target;
    this._ensureSeedSlots();
  }

  hotbarItems() {
    if (!this.game) return [];
    const base = [];
    for (const id of PERMANENT) if (ITEMS[id] && !base.includes(id)) base.push(id);
    for (const id of this._placeableItems()) {
      if (base.length >= HOTBAR_LIMIT) break;
      if (!base.includes(id)) base.push(id);
    }

    const sel = this.game.selected;
    if (sel && this._canHotbar(sel) && !base.includes(sel)) {
      if (base.length < HOTBAR_LIMIT) base.push(sel);
      else base[HOTBAR_LIMIT - 1] = sel;
    }
    return base.slice(0, HOTBAR_LIMIT);
  }

  selectSlot(n) {
    if (n < 1 || n > HOTBAR_LIMIT) return;
    const items = this.hotbarItems();
    if (items[n - 1]) {
      this.game.selected = items[n - 1];
      this._ensureSelected();
    }
  }

  render(ctx, now = performance.now()) {
    if (!this.game || !this.game.running) return;
    this.hit = emptyHit();
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    this._drawDrawer(ctx, now);
    ctx.restore();
  }

  textState() {
    this._syncDrawerMetrics();
    return {
      expanded: this._isExpanded(),
      drawerVisibleHeight: Math.round(this.drawerVisibleHeight || 0),
      collapsedHeight: Math.round(this.collapsedHeight || 0),
      maxDrawerHeight: Math.round(this.maxDrawerHeight || 0),
      hotbarLimit: HOTBAR_LIMIT,
      hotbar: this.hotbarItems(),
      seedSlots: [...this.seedSlots],
      activeSeedSlot: this.activeSeedSlot,
    };
  }

  blocksPointer(x, y) {
    return !!(this.hit.panel && pointInRect(x, y, this.hit.panel));
  }

  _wireCanvas() {
    const canvas = this.game && this.game.canvas;
    if (!canvas || this._wiredCanvas === canvas) return;
    this._wiredCanvas = canvas;

    canvas.addEventListener('mousemove', (e) => { this.pointer = this._eventPoint(e); });
    canvas.addEventListener('mouseleave', () => { this.pointer = { x: -1, y: -1 }; });

    canvas.addEventListener('pointerdown', (e) => {
      const p = this._eventPoint(e);
      this.pointer = p;
      if (this._handlePointDown(p, e)) {
        this._suppressMouseUntil = performance.now() + 500;
        stopCanvasEvent(e);
      }
    }, { capture: true });

    canvas.addEventListener('mousedown', (e) => {
      const p = this._eventPoint(e);
      this.pointer = p;
      if (performance.now() < this._suppressMouseUntil) {
        stopCanvasEvent(e);
        return;
      }
      if (this._handlePointDown(p, e)) stopCanvasEvent(e);
    }, { capture: true });

    canvas.addEventListener('pointermove', (e) => {
      const p = this._eventPoint(e);
      this.pointer = p;
      if (this._dragDrawer && this._dragDrawer.pointerId === e.pointerId) {
        this.drawerVisibleHeight = clamp(
          this._dragDrawer.visible + (this._dragDrawer.y - p.y),
          this.collapsedHeight,
          this.maxDrawerHeight,
        );
        stopCanvasEvent(e);
        return;
      }
      if (!this._dragScroll || this._dragScroll.pointerId !== e.pointerId) return;
      this.inventoryScroll = clamp(this._dragScroll.scroll - (p.y - this._dragScroll.y), 0, this.maxScroll);
      stopCanvasEvent(e);
    }, { capture: true });

    window.addEventListener('pointerup', (e) => {
      if (this._dragScroll && this._dragScroll.pointerId === e.pointerId) this._dragScroll = null;
      if (this._dragDrawer && this._dragDrawer.pointerId === e.pointerId) this._dragDrawer = null;
    });
    window.addEventListener('pointercancel', (e) => {
      if (this._dragScroll && this._dragScroll.pointerId === e.pointerId) this._dragScroll = null;
      if (this._dragDrawer && this._dragDrawer.pointerId === e.pointerId) this._dragDrawer = null;
    });

    canvas.addEventListener('wheel', (e) => {
      const p = this._eventPoint(e);
      this.pointer = p;
      if (this.hit.panel && pointInRect(p.x, p.y, this.hit.panel)) {
        if (this.hit.grid && pointInRect(p.x, p.y, this.hit.grid)) {
          this.inventoryScroll = clamp(this.inventoryScroll + e.deltaY, 0, this.maxScroll);
        }
        stopCanvasEvent(e);
      }
    }, { capture: true, passive: false });
  }

  _handlePointDown(p, e) {
    if (!this.game || this.ui.modalOpen()) return false;

    if (!this.hit.panel || !pointInRect(p.x, p.y, this.hit.panel)) return false;

    if (this.hit.handle && pointInRect(p.x, p.y, this.hit.handle)) {
      this._dragDrawer = { y: p.y, visible: this.drawerVisibleHeight, pointerId: e.pointerId };
      return true;
    }

    const hot = this.hit.hotbar.find((h) => pointInRect(p.x, p.y, h));
    if (hot) {
      this._selectItem(hot.id);
      return true;
    }

    const seed = this.hit.seedSlots.find((h) => pointInRect(p.x, p.y, h));
    if (seed) {
      this.activeSeedSlot = seed.index;
      this._cycleSeedSlot(seed.index, e.button === 2 ? -1 : 1);
      return true;
    }

    if (this.hit.splice && pointInRect(p.x, p.y, this.hit.splice)) {
      this._spliceSelectedSeeds();
      return true;
    }

    const inv = this.hit.inventorySlots.find((h) => pointInRect(p.x, p.y, h));
    if (inv) {
      this._selectInventoryItem(inv.id);
      return true;
    }

    if (this.hit.grid && pointInRect(p.x, p.y, this.hit.grid)) {
      this._dragScroll = { y: p.y, scroll: this.inventoryScroll, pointerId: e.pointerId };
      return true;
    }

    return true;
  }

  _drawDrawer(ctx) {
    const cw = this.game.canvas.width;
    const ch = this.game.canvas.height;
    const fullPanel = this._panelRect(cw, ch);
    const s = fullPanel.h / BG_H;
    this._syncDrawerMetrics(fullPanel);

    const panel = { ...fullPanel, y: Math.round(ch - this.drawerVisibleHeight) };
    this.hit.panel = {
      x: panel.x,
      y: panel.y,
      w: panel.w,
      h: Math.min(panel.h, ch - panel.y),
    };
    this.hit.handle = srcRect(panel, { x: 360, y: 0, w: 304, h: 94 });

    if (ready(uiImages.inventory)) {
      ctx.drawImage(uiImages.inventory, panel.x, panel.y, panel.w, panel.h);
    } else {
      ctx.fillStyle = '#21160e';
      roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 18); ctx.fill();
    }

    this._drawPanelHotbar(ctx, panel, s);
    this._drawInventoryGrid(ctx, panel, s);
    this._drawSeedSlots(ctx, panel, s);
  }

  _drawPanelHotbar(ctx, panel, s) {
    const items = this.hotbarItems();
    const slotSrc = [];
    const startX = 278;
    for (let i = 0; i < HOTBAR_LIMIT; i++) slotSrc.push({ x: startX + i * 94, y: 115, w: 78, h: 72 });

    this.hit.hotbar = [];
    for (let i = 0; i < HOTBAR_LIMIT; i++) {
      const r = srcRect(panel, slotSrc[i]);
      r.id = items[i];
      r.index = i;
      this.hit.hotbar.push(r);
      if (items[i] && this.game.selected === items[i]) this._drawSelectionFrame(ctx, r, 4 * s);
      if (items[i]) this._drawItemInRect(ctx, items[i], r, { key: i + 1, count: this._countFor(items[i]), compact: true });
    }
  }

  _drawInventoryGrid(ctx, panel, s) {
    const grid = srcRect(panel, { x: 181, y: 263, w: 662, h: 830 });
    const items = this._inventoryItems();
    const cols = 6;
    const gap = Math.max(4, 12 * s);
    const slotW = (grid.w - gap * (cols - 1)) / cols;
    const slotH = slotW;
    const pitch = slotH + gap;
    const rows = Math.ceil(items.length / cols);
    this.maxScroll = Math.max(0, rows * pitch - grid.h);
    this.inventoryScroll = clamp(this.inventoryScroll, 0, this.maxScroll);
    this.hit.grid = grid;
    this.hit.inventorySlots = [];

    ctx.save();
    ctx.beginPath();
    ctx.rect(grid.x, grid.y, grid.w, grid.h);
    ctx.clip();

    for (let idx = 0; idx < items.length; idx++) {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const x = grid.x + col * (slotW + gap);
      const y = grid.y + row * pitch - this.inventoryScroll;
      if (y > grid.y + grid.h || y + slotH < grid.y) continue;
      const id = items[idx];
      const it = ITEMS[id];
      const worn = isClothing(id) && this.game.me.equipped && this.game.me.equipped[it.slot || 'body'] === id;
      const hovered = pointInRect(this.pointer.x, this.pointer.y, { x, y, w: slotW, h: slotH });
      const state = this.game.selected === id ? 'selected' : (worn || hovered ? 'focused' : 'normal');
      const r = { x, y, w: slotW, h: slotH, id, index: idx };
      this.hit.inventorySlots.push(r);
      this._drawInventoryCell(ctx, r, state);
      this._drawItemInRect(ctx, id, r, { count: this._countFor(id), compact: true });
    }
    ctx.restore();

    if (this.maxScroll > 1) this._drawScrollPip(ctx, grid);
  }

  _drawSeedSlots(ctx, panel, s) {
    const slots = [
      srcRect(panel, { x: 190, y: 1148, w: 304, h: 214 }),
      srcRect(panel, { x: 536, y: 1148, w: 304, h: 214 }),
    ];
    this.hit.seedSlots = [];
    for (let i = 0; i < slots.length; i++) {
      const r = { ...slots[i], index: i };
      this.hit.seedSlots.push(r);
      if (this.activeSeedSlot === i) this._drawSelectionFrame(ctx, r, 5 * s);
      const id = this.seedSlots[i];
      if (id) {
        this._drawItemIcon(ctx, id, r.x + r.w / 2, r.y + r.h * 0.42, Math.min(r.w, r.h) * 0.42);
        this._drawCount(ctx, this._countFor(id), r.x + r.w - 16 * s, r.y + r.h - 28 * s, Math.max(10, 14 * s));
        this._drawFittedText(ctx, ITEMS[id]?.name || id, r.x + 18 * s, r.y + r.h - 20 * s, r.w - 36 * s, 13 * s);
      } else {
        ctx.save();
        ctx.globalAlpha = 0.35;
        this._drawItemIcon(ctx, 'dirt_seed', r.x + r.w / 2, r.y + r.h * 0.48, Math.min(r.w, r.h) * 0.3);
        ctx.restore();
      }
    }

    const button = srcRect(panel, { x: 493, y: 1184, w: 52, h: 128 });
    this.hit.splice = button;
    const readyToSplice = this.seedSlots[0] && this.seedSlots[1] && this.seedSlots[0] !== this.seedSlots[1];
    ctx.save();
    ctx.globalAlpha = readyToSplice ? 0.95 : 0.45;
    ctx.fillStyle = readyToSplice ? 'rgba(242, 197, 49, .26)' : 'rgba(0, 0, 0, .18)';
    ctx.strokeStyle = readyToSplice ? 'rgba(255, 230, 138, .8)' : 'rgba(255, 255, 255, .25)';
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.beginPath();
    ctx.arc(button.x + button.w / 2, button.y + button.h / 2, Math.min(button.w, button.h) * 0.28, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    const cx = button.x + button.w / 2;
    const cy = button.y + button.h / 2;
    const r = Math.min(button.w, button.h) * 0.2;
    ctx.strokeStyle = readyToSplice ? '#ffe68a' : '#d3b578';
    ctx.lineWidth = Math.max(1.5, 3 * s);
    for (let strand = 0; strand < 2; strand++) {
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const y = cy - r + t * r * 2;
        const phase = t * Math.PI * 2 + strand * Math.PI;
        const x = cx + Math.sin(phase) * r * 0.5;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 2; i <= 14; i += 4) {
      const t = i / 16;
      const y = cy - r + t * r * 2;
      const a = Math.sin(t * Math.PI * 2) * r * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx - a, y);
      ctx.lineTo(cx + a, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _selectInventoryItem(id) {
    const it = ITEMS[id];
    if (!it) return;
    if (isClothing(id)) {
      const now = performance.now();
      if (this._lastTap.id === id && now - this._lastTap.t < 340) {
        this.netSend('equip', { itemId: id });
        this._lastTap = { id: null, t: 0 };
      } else {
        this._lastTap = { id, t: now };
      }
      return;
    }
    if (isPlaceable(id) || it.permanent) this._selectItem(id);
    if (it.type === 'seed') this._assignSeed(id);
  }

  _selectItem(id) {
    if (!ITEMS[id]) return;
    this.game.selected = id;
    this._ensureSelected();
  }

  _assignSeed(id) {
    if (!ITEMS[id] || ITEMS[id].type !== 'seed') return;
    this.seedSlots[this.activeSeedSlot] = id;
    const other = this.activeSeedSlot === 0 ? 1 : 0;
    if (this.seedSlots[other] === id) {
      const alt = this._seedItems().find((s) => s !== id);
      if (alt) this.seedSlots[other] = alt;
    }
    this.activeSeedSlot = other;
  }

  _cycleSeedSlot(index, dir) {
    const seeds = this._seedItems();
    if (!seeds.length) {
      this.seedSlots[index] = null;
      return;
    }
    const current = this.seedSlots[index];
    const cur = Math.max(0, seeds.indexOf(current));
    this.seedSlots[index] = seeds[(cur + dir + seeds.length) % seeds.length];
    if (seeds.length > 1) {
      const other = index === 0 ? 1 : 0;
      if (this.seedSlots[other] === this.seedSlots[index]) {
        const next = seeds.find((id) => id !== this.seedSlots[index]);
        if (next) this.seedSlots[other] = next;
      }
    }
  }

  _spliceSelectedSeeds() {
    const [a, b] = this.seedSlots;
    if (!a || !b) {
      this.ui.toast('Select two seeds first.');
      return;
    }
    if (a === b) {
      this.ui.toast('Pick two different seeds.');
      return;
    }
    this.netSend('splice', { a, b });
  }

  netSend(type, payload) {
    if (!this.ui.net.send(type, payload)) this.ui.toast('Still connecting to the game server.');
  }

  _ensureSelected() {
    const sel = this.game.selected;
    if (sel && this._canHotbar(sel)) return;
    const items = this.hotbarItems();
    this.game.selected = items[0] || 'fist';
  }

  _ensureSeedSlots() {
    const seeds = this._seedItems();
    for (let i = 0; i < 2; i++) {
      if (!this.seedSlots[i] || !seeds.includes(this.seedSlots[i])) this.seedSlots[i] = seeds[i] || null;
    }
    if (seeds.length > 1 && this.seedSlots[0] === this.seedSlots[1]) {
      this.seedSlots[1] = seeds.find((id) => id !== this.seedSlots[0]) || null;
    }
  }

  _canHotbar(id) {
    const it = ITEMS[id];
    if (!it) return false;
    if (it.permanent) return true;
    return (this.game.me.inventory[id] || 0) > 0 && isPlaceable(id);
  }

  _placeableItems() {
    return Object.keys(this.game.me.inventory)
      .filter((id) => this.game.me.inventory[id] > 0 && isPlaceable(id));
  }

  _inventoryItems() {
    const inv = this.game.me.inventory;
    return Object.keys(inv)
      .filter((id) => inv[id] > 0 && ITEMS[id])
      .sort((a, b) => (ITEMS[b]?.permanent ? 1 : 0) - (ITEMS[a]?.permanent ? 1 : 0));
  }

  _seedItems() {
    return this._inventoryItems().filter((id) => ITEMS[id].type === 'seed');
  }

  _countFor(id) {
    if (!id || ITEMS[id]?.permanent) return 0;
    return this.game.me.inventory[id] || 0;
  }

  _syncDrawerMetrics(fullPanel = null) {
    if (!this.game) return;
    const panel = fullPanel || this._panelRect(this.game.canvas.width, this.game.canvas.height);
    const s = panel.h / BG_H;
    this.collapsedHeight = COLLAPSED_SRC_H * s;
    this.maxDrawerHeight = panel.h;
    if (this.drawerVisibleHeight == null) this.drawerVisibleHeight = this.collapsedHeight;
    this.drawerVisibleHeight = clamp(this.drawerVisibleHeight, this.collapsedHeight, this.maxDrawerHeight);
  }

  _isExpanded() {
    this._syncDrawerMetrics();
    const midpoint = this.collapsedHeight + (this.maxDrawerHeight - this.collapsedHeight) * 0.45;
    return this.drawerVisibleHeight > midpoint;
  }

  _panelRect(cw, ch) {
    let h = Math.min(ch - 24, 760);
    let w = h * (BG_W / BG_H);
    if (w > cw - 24) {
      w = cw - 24;
      h = w * (BG_H / BG_W);
    }
    return {
      x: Math.round((cw - w) / 2),
      y: Math.round(ch - h - 8),
      w,
      h,
    };
  }

  _drawInventoryCell(ctx, r, state) {
    ctx.save();
    ctx.globalAlpha = state === 'normal' ? 0.62 : 0.86;
    ctx.fillStyle = state === 'selected' ? 'rgba(92, 52, 21, .84)' : 'rgba(70, 42, 20, .66)';
    ctx.strokeStyle = state === 'selected' ? 'rgba(255, 220, 112, .9)' : (state === 'focused' ? 'rgba(232, 174, 88, .75)' : 'rgba(75, 43, 21, .55)');
    ctx.lineWidth = Math.max(1, r.w * 0.025);
    roundRect(ctx, r.x, r.y, r.w, r.h, Math.max(5, r.w * 0.12));
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _drawItemInRect(ctx, id, r, opts = {}) {
    const iconSize = Math.min(r.w, r.h) * (opts.compact ? 0.58 : 0.64);
    this._drawItemIcon(ctx, id, r.x + r.w / 2, r.y + r.h / 2 + (opts.compact ? r.h * 0.02 : 0), iconSize);
    if (opts.key != null) this._drawKey(ctx, opts.key, r.x + r.w * 0.18, r.y + r.h * 0.18, Math.max(9, r.w * 0.22));
    if (opts.count > 0) this._drawCount(ctx, opts.count, r.x + r.w * 0.82, r.y + r.h * 0.82, Math.max(9, r.w * 0.2));
  }

  _drawItemIcon(ctx, id, cx, cy, size) {
    const img = tileSprite(id);
    if (img) {
      const drawSize = Math.max(1, Math.round(size));
      ctx.save();
      setImageSmoothing(ctx, false);
      ctx.drawImage(img, Math.round(cx - drawSize / 2), Math.round(cy - drawSize / 2), drawSize, drawSize);
      ctx.restore();
      return;
    }
    ctx.font = `${Math.max(13, size * 0.72)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(ITEMS[id]?.icon || '?', cx, cy);
  }

  _drawKey(ctx, key, x, y, size) {
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size * 0.18);
    ctx.strokeStyle = 'rgba(0, 0, 0, .75)';
    ctx.fillStyle = '#d8e4f1';
    ctx.strokeText(String(key), x, y);
    ctx.fillText(String(key), x, y);
  }

  _drawCount(ctx, count, x, y, size) {
    if (!count) return;
    const text = count > 999 ? '999+' : String(count);
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size * 0.2);
    ctx.strokeStyle = 'rgba(0, 0, 0, .82)';
    ctx.fillStyle = '#fff5d1';
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  _drawFittedText(ctx, text, x, y, maxW, size) {
    ctx.font = `bold ${Math.max(9, size)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    let shown = text;
    while (shown.length > 3 && ctx.measureText(shown).width > maxW) shown = shown.slice(0, -2) + '.';
    ctx.strokeStyle = 'rgba(0, 0, 0, .78)';
    ctx.fillStyle = '#f8e8bb';
    ctx.strokeText(shown, x + maxW / 2, y);
    ctx.fillText(shown, x + maxW / 2, y);
  }

  _drawSelectionFrame(ctx, r, inset) {
    ctx.save();
    ctx.strokeStyle = '#ffe68a';
    ctx.shadowColor = 'rgba(255, 214, 80, .8)';
    ctx.shadowBlur = 8;
    ctx.lineWidth = Math.max(2, inset * 0.7);
    roundRect(ctx, r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, Math.max(4, inset * 2));
    ctx.stroke();
    ctx.restore();
  }

  _drawScrollPip(ctx, grid) {
    const trackH = grid.h * 0.92;
    const x = grid.x + grid.w + 5;
    const y = grid.y + grid.h * 0.04;
    const thumbH = Math.max(18, trackH * (grid.h / (grid.h + this.maxScroll)));
    const t = this.maxScroll ? this.inventoryScroll / this.maxScroll : 0;
    ctx.fillStyle = 'rgba(65, 39, 20, .35)';
    roundRect(ctx, x, y, 4, trackH, 3); ctx.fill();
    ctx.fillStyle = 'rgba(247, 203, 116, .75)';
    roundRect(ctx, x - 1, y + (trackH - thumbH) * t, 6, thumbH, 3); ctx.fill();
  }

  _eventPoint(e) {
    const r = this.game.canvas.getBoundingClientRect();
    const sx = this.game.canvas.width / Math.max(1, r.width);
    const sy = this.game.canvas.height / Math.max(1, r.height);
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

}

function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img;
}

function ready(img) {
  return !!(img && img.complete && img.naturalWidth > 0);
}

function setImageSmoothing(ctx, enabled) {
  for (const key of ['imageSmoothingEnabled', 'webkitImageSmoothingEnabled', 'mozImageSmoothingEnabled', 'msImageSmoothingEnabled']) {
    if (key in ctx) ctx[key] = enabled;
  }
}

function srcRect(panel, r) {
  const sx = panel.w / BG_W;
  const sy = panel.h / BG_H;
  return {
    x: panel.x + r.x * sx,
    y: panel.y + r.y * sy,
    w: r.w * sx,
    h: r.h * sy,
  };
}

function pointInRect(x, y, r) {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function stopCanvasEvent(e) {
  if (e.cancelable) e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

function emptyHit() {
  return {
    hotbar: [],
    inventorySlots: [],
    seedSlots: [],
    panel: null,
    grid: null,
    splice: null,
    handle: null,
  };
}
