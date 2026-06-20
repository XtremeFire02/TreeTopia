// Core game: world state, physics, rendering, and network event wiring.
import {
  TILE, GRAVITY, MOVE_SPEED, JUMP_VELOCITY, MAX_FALL,
  PLAYER_W, PLAYER_H, REACH, RESPAWN_MS, BREAK_RESET_MS,
} from './shared/constants.js';
import { ITEMS, isSolid, hasEffect, hasEquippedEffect, isPlaceable } from './shared/items.js';
import { DEVELOPER_NAME_COLOR, DEVELOPER_NAME_STROKE } from './shared/names.js';
import { keys, mouse } from './input.js';
import { tileSprite, dropSprite } from './assets.js';

export class Game {
  constructor(net, ui) {
    this.net = net;
    this.ui = ui;
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.me = { id: 0, name: '', gems: 0, inventory: {}, equipped: {}, dev: false };

    this.world = null;
    this.drops = new Map();
    this.others = new Map();
    this.breakFx = new Map();      // "x,y" -> {hits,hardness,t}
    this.particles = [];

    this.local = { x: 0, y: 0, vx: 0, vy: 0, dir: 1, onGround: false, anim: 'idle', walkT: 0, dead: false, deadAt: 0, jumpsUsed: 0, punchAt: 0, punchDir: 1, punchAngle: 0, punchDist: 0, punchSeq: 0 };
    this.camera = { x: 0, y: 0 };
    this.zoom = 1;                 // pinch-to-zoom factor (1 = default)
    this.selected = null;          // item id chosen on hotbar for placing
    this.touchBgMode = false;      // mobile: place into the background layer (Shift on desktop)
    this.punchHeld = false;        // mobile: on-screen punch button held
    this.running = false;
    this._lastMoveSend = 0;
    this._lastAction = 0;
    this._acc = 0;

    this._bindResize();
    this._wireNet();
  }

  _bindResize() {
    const fit = () => {
      this.canvas.width = this.canvas.clientWidth;
      this.canvas.height = this.canvas.clientHeight;
    };
    window.addEventListener('resize', fit);
    this._fit = fit;
  }

  // ---------- network events ----------
  _wireNet() {
    const n = this.net;
    n.on('worldData', (m) => this.onWorldData(m));
    n.on('tileUpdate', (m) => this.onTileUpdate(m));
    n.on('dropAdd', (m) => this.drops.set(m.drop.id, m.drop));
    n.on('dropRemove', (m) => this.drops.delete(m.id));
    n.on('playerJoin', (m) => this.others.set(m.player.id, mkOther(m.player)));
    n.on('playerLeave', (m) => this.others.delete(m.id));
    n.on('playerMove', (m) => {
      const o = this.others.get(m.id) || mkOther(m);
      const punchSeq = m.punchSeq ?? 0;
      if (m.anim === 'punch' && (punchSeq !== (o.punchSeq ?? 0) || (!('punchSeq' in m) && o.anim !== 'punch'))) {
        o.punchAt = performance.now();
      }
      o.tx = m.x; o.ty = m.y; o.dir = m.dir; o.anim = m.anim; o.name = m.name;
      o.punchAngle = m.punchAngle || 0; o.punchDist = m.punchDist || 0; o.punchSeq = punchSeq;
      if (m.equipped) o.equipped = m.equipped;
      if (m.dev !== undefined) o.dev = m.dev;
      this.others.set(m.id, o);
    });
    n.on('breakProgress', (m) => {
      this.breakFx.set(m.x + ',' + m.y, { hits: m.hits, hardness: m.hardness, t: performance.now() });
    });
    n.on('breakReset', (m) => this.breakFx.delete(m.x + ',' + m.y));
    n.on('respawnAt', (m) => { this.local.x = m.x; this.local.y = m.y; this.local.vx = 0; this.local.vy = 0; });
    n.on('inventory', (m) => {
      this.me.inventory = m.inventory; this.me.gems = m.gems;
      if (m.equipped) this.me.equipped = m.equipped;
      this.ui.onInventory();
    });
    n.on('devStatus', (m) => { this.me.dev = !!m.dev; this.ui.onDevStatus(); });
  }

  onWorldData(m) {
    this.world = m.world;
    this.drops = new Map();
    (m.drops || []).forEach((d) => this.drops.set(d.id, d));
    this.others = new Map();
    (m.players || []).forEach((p) => this.others.set(p.id, mkOther(p)));
    this.local.x = m.you.x; this.local.y = m.you.y; this.local.vx = 0; this.local.vy = 0; this.local.dead = false;
    this.breakFx.clear(); this.particles.length = 0;
    this.ui.onEnterWorld(m.world, m.ownerDev);
    document.dispatchEvent(new Event('enteredWorld'));
    this.start();
  }

  onTileUpdate(m) {
    const w = this.world; if (!w) return;
    const i = m.y * w.width + m.x;
    if (m.fg !== undefined) w.fg[i] = m.fg;
    if (m.bg !== undefined) w.bg[i] = m.bg;
    if (m.data !== undefined) { if (m.data === null) delete w.data[i]; else w.data[i] = m.data; }
    // keep the local world owner in sync when a World Lock is placed/removed
    if (m.data && m.data.lock && m.data.lock.scope === 'world') w.owner = m.data.lock.owner;
    else if (m.fg === '' && w.fg[i] === '' && m.data === null) { /* a tile cleared; owner re-derived on next enter */ }
    this.breakFx.delete(m.x + ',' + m.y);
    if (m.fg === '') this.spawnPoof(m.x * TILE + TILE / 2, m.y * TILE + TILE / 2);
  }

  // ---------- loop ----------
  start() {
    if (this.running) return;
    this.running = true;
    this._fit();
    this.last = performance.now();
    requestAnimationFrame(this._frame.bind(this));
  }
  stop() { this.running = false; if (this.ui) this.ui.updatePlayerTags([], this.camera, false); }

  _frame(now) {
    if (!this.running) return;
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.05) dt = 0.05;            // clamp big stalls
    this.update(dt, now);
    this.render(now);
    requestAnimationFrame(this._frame.bind(this));
  }

  // ---------- simulation ----------
  update(dt, now) {
    const L = this.local, w = this.world; if (!w) return;

    if (L.dead) {
      // float-up death animation, then respawn
      L.deadT += dt;
      if (now - L.deadAt > RESPAWN_MS) this.finishRespawn();
      this.updateParticles(dt);
      this.updateCamera(dt);
      this.updateOthers(dt);
      return;
    }

    // horizontal input
    let move = 0;
    if (keys['arrowleft'] || keys['a']) move -= 1;
    if (keys['arrowright'] || keys['d']) move += 1;
    L.vx = move * MOVE_SPEED;
    if (move !== 0) L.dir = move;

    // jump (edge-triggered; second jump in mid-air with Angel Wings)
    const jumpKey = keys['arrowup'] || keys['w'] || keys[' '];
    const maxJumps = hasEquippedEffect(this.me.equipped, 'double_jump') ? 2 : 1;
    if (L.onGround) L.jumpsUsed = 0;
    if (jumpKey && !this._jumpHeld && L.jumpsUsed < maxJumps) {
      L.vy = -JUMP_VELOCITY; L.onGround = false; L.jumpsUsed++;
    }
    this._jumpHeld = jumpKey;

    // gravity
    L.vy += GRAVITY * dt;
    if (L.vy > MAX_FALL) L.vy = MAX_FALL;

    this.moveX(L.vx * dt);
    this.moveY(L.vy * dt);

    // anim
    if (!L.onGround) L.anim = 'jump';
    else if (move !== 0) { L.anim = 'walk'; L.walkT += dt * 10; }
    else L.anim = 'idle';

    // hazard: lava / spikes = death
    if (this.touchingHazard()) this.die();
    if (L.y > (w.height + 4) * TILE) this.die();

    // mouse build/break (may start a punch)
    this.handleBuild(now);
    this.handlePunchButton(now);   // on-screen punch button (mobile)
    if (now - L.punchAt < 220) { L.anim = 'punch'; L.dir = L.punchDir; } // face the punch

    this.updateParticles(dt);
    this.updateCamera(dt);
    this.updateOthers(dt);

    // send movement to server
    if (now - this._lastMoveSend > 70) {
      this._lastMoveSend = now;
      this.net.send('move', { x: L.x, y: L.y, vx: L.vx, vy: L.vy, dir: L.dir, anim: L.anim, punchAngle: L.punchAngle, punchDist: L.punchDist, punchSeq: L.punchSeq, name: this.me.name });
    }
  }

  // axis-separated AABB collision against solid foreground tiles
  moveX(d) {
    const L = this.local;
    L.x += d;
    const box = this.box();
    const minTy = Math.floor(box.top / TILE), maxTy = Math.floor((box.bottom - 1) / TILE);
    if (d > 0) {
      const tx = Math.floor((box.right) / TILE);
      for (let ty = minTy; ty <= maxTy; ty++) if (this.solidAt(tx, ty)) { L.x = tx * TILE - PLAYER_W / 2 - 0.01; break; }
    } else if (d < 0) {
      const tx = Math.floor(box.left / TILE);
      for (let ty = minTy; ty <= maxTy; ty++) if (this.solidAt(tx, ty)) { L.x = (tx + 1) * TILE + PLAYER_W / 2 + 0.01; break; }
    }
  }
  moveY(d) {
    const L = this.local;
    L.y += d;
    const box = this.box();
    const minTx = Math.floor(box.left / TILE), maxTx = Math.floor((box.right - 1) / TILE);
    if (d > 0) { // falling
      const ty = Math.floor(box.bottom / TILE);
      for (let tx = minTx; tx <= maxTx; tx++) if (this.solidAt(tx, ty)) { L.y = ty * TILE - 0.01; L.vy = 0; L.onGround = true; return; }
      L.onGround = false;
    } else if (d < 0) { // jumping up
      const ty = Math.floor(box.top / TILE);
      for (let tx = minTx; tx <= maxTx; tx++) if (this.solidAt(tx, ty)) { L.y = (ty + 1) * TILE + PLAYER_H + 0.01; L.vy = 0; return; }
    }
  }

  box() {
    const L = this.local;
    return { left: L.x - PLAYER_W / 2, right: L.x + PLAYER_W / 2, top: L.y - PLAYER_H, bottom: L.y };
  }
  solidAt(tx, ty) {
    const w = this.world;
    if (tx < 0 || tx >= w.width || ty < 0) return true;
    if (ty >= w.height) return true;
    return isSolid(w.fg[ty * w.width + tx]);
  }
  touchingHazard() {
    const b = this.box(), w = this.world;
    for (let ty = Math.floor(b.top / TILE); ty <= Math.floor((b.bottom - 1) / TILE); ty++)
      for (let tx = Math.floor(b.left / TILE); tx <= Math.floor((b.right - 1) / TILE); tx++) {
        const it = ITEMS[w.fg[ty * w.width + tx]];
        if (it && it.hazard) return true;
      }
    return false;
  }

  // the growing tree the player is currently overlapping (for the countdown bubble)
  treeUnderPlayer() {
    const b = this.box(), w = this.world;
    for (let ty = Math.floor(b.top / TILE); ty <= Math.floor((b.bottom - 1) / TILE); ty++)
      for (let tx = Math.floor(b.left / TILE); tx <= Math.floor((b.right - 1) / TILE); tx++) {
        const i = ty * w.width + tx;
        const d = w.data[i];
        if (w.fg[i] === '__tree__' && d && d.tree) {
          const left = d.tree.growTime * 1000 - (Date.now() - d.tree.plantedAt);
          if (left > 0) return { tx, ty, left, seed: d.tree.seed };
        }
      }
    return null;
  }

  // ---------- building ----------
  handleBuild(now) {
    if (this.ui.modalOpen()) return;
    if (this.selected === 'wrench') return; // wrench mode = inspect players, no building
    const t = this.pointerTile();
    if (!t) return;
    if (!this.inReach(t.x, t.y)) return;
    if (mouse.left && now - this._lastAction > 200) {
      this._lastAction = now; this.local.punchAt = now;
      this.local.punchSeq++;
      // aim the punch at the CENTRE of the target block (not the exact cursor pixel)
      const tcx = (t.x + 0.5) * TILE, tcy = (t.y + 0.5) * TILE;
      const dx = tcx - this.local.x, dy = tcy - (this.local.y - TILE * 0.55);
      const maxReach = (REACH + (hasEffect(this.me.inventory, 'long_punch') ? 2 : 0)) * TILE;
      this.local.punchAngle = Math.atan2(dy, dx);
      this.local.punchDist = Math.min(Math.hypot(dx, dy), maxReach);
      this.local.punchDir = Math.cos(this.local.punchAngle) >= 0 ? 1 : -1;
      this.net.send('break', { x: t.x, y: t.y });
    } else if (mouse.right && this.selected && isPlaceable(this.selected) && now - this._lastAction > 200) {
      this._lastAction = now;
      this.net.send('place', { x: t.x, y: t.y, itemId: this.selected, layer: (keys['shift'] || this.touchBgMode) ? 1 : 0 });
    }
  }
  // On-screen punch button: break the tile directly in front of the player.
  handlePunchButton(now) {
    if (!this.punchHeld || !this.world) return;
    if (this.ui.modalOpen() || this.selected === 'wrench') return;
    if (now - this._lastAction <= 200) return;
    const tx = Math.floor(this.local.x / TILE) + this.local.dir;
    const ty = Math.floor((this.local.y - TILE / 2) / TILE);
    if (tx < 0 || ty < 0 || tx >= this.world.width || ty >= this.world.height) return;
    if (!this.inReach(tx, ty)) return;
    this._lastAction = now; this.local.punchAt = now; this.local.punchSeq++;
    const tcx = (tx + 0.5) * TILE, tcy = (ty + 0.5) * TILE;
    const dx = tcx - this.local.x, dy = tcy - (this.local.y - TILE * 0.55);
    const maxReach = (REACH + (hasEffect(this.me.inventory, 'long_punch') ? 2 : 0)) * TILE;
    this.local.punchAngle = Math.atan2(dy, dx);
    this.local.punchDist = Math.min(Math.hypot(dx, dy), maxReach);
    this.local.punchDir = Math.cos(this.local.punchAngle) >= 0 ? 1 : -1;
    this.net.send('break', { x: tx, y: ty });
  }
  pointerTile() {
    const wx = mouse.sx / this.zoom + this.camera.x, wy = mouse.sy / this.zoom + this.camera.y;
    const x = Math.floor(wx / TILE), y = Math.floor(wy / TILE);
    if (!this.world || x < 0 || y < 0 || x >= this.world.width || y >= this.world.height) return null;
    return { x, y };
  }
  inReach(tx, ty) {
    const reach = REACH + (hasEffect(this.me.inventory, 'long_punch') ? 2 : 0);
    const px = this.local.x / TILE, py = (this.local.y - TILE / 2) / TILE;
    return Math.abs(px - (tx + 0.5)) <= reach + 0.5 && Math.abs(py - (ty + 0.5)) <= reach + 0.5;
  }

  // ---------- death / respawn ----------
  die() {
    if (this.local.dead) return;
    this.local.dead = true; this.local.deadAt = performance.now(); this.local.deadT = 0;
    this.local.vx = 0; this.local.vy = 0;
    for (let i = 0; i < 22; i++) this.particles.push({
      x: this.local.x, y: this.local.y - PLAYER_H / 2,
      vx: (Math.random() - 0.5) * 220, vy: -Math.random() * 260 - 40,
      life: 1, color: ['#d24a4a', '#f2c531', '#ffffff'][i % 3], r: 3 + Math.random() * 3,
    });
    this.ui.showDeath(true);
  }
  finishRespawn() {
    this.local.dead = false;
    this.ui.showDeath(false);
    this.net.send('respawn');
    if (this.world) { // instant local feedback
      const s = this.world.spawn;
      this.local.x = s.tx * TILE + TILE / 2; this.local.y = s.ty * TILE + TILE;
      this.local.vx = 0; this.local.vy = 0;
    }
  }
  requestRespawn() { if (!this.local.dead) this.die(); }

  // ---------- particles ----------
  spawnPoof(x, y) {
    for (let i = 0; i < 8; i++) this.particles.push({
      x, y, vx: (Math.random() - 0.5) * 150, vy: -Math.random() * 120 - 20,
      life: 0.6, color: '#cdbfa6', r: 2 + Math.random() * 2,
    });
  }
  updateParticles(dt) {
    for (const p of this.particles) { p.vy += 700 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  updateOthers(dt) {
    for (const o of this.others.values()) {
      o.x += (o.tx - o.x) * Math.min(1, dt * 12);
      o.y += (o.ty - o.y) * Math.min(1, dt * 12);
      if (Math.abs(o.tx - o.x) > 1) o.walkT += dt * 10;
    }
  }

  setZoom(z) { this.zoom = clamp(z, 0.6, 3); }
  zoomBy(factor) { this.setZoom(this.zoom * factor); }

  updateCamera(dt) {
    const w = this.world;
    const vw = this.canvas.width / this.zoom, vh = this.canvas.height / this.zoom;
    const targetX = this.local.x - vw / 2;
    const targetY = this.local.y - vh / 2;
    this.camera.x += (targetX - this.camera.x) * Math.min(1, dt * 8);
    this.camera.y += (targetY - this.camera.y) * Math.min(1, dt * 8);
    this.camera.x = clamp(this.camera.x, 0, w.width * TILE - vw);
    this.camera.y = clamp(this.camera.y, 0, w.height * TILE - vh);
    if (w.width * TILE < vw) this.camera.x = (w.width * TILE - vw) / 2;
    if (w.height * TILE < vh) this.camera.y = (w.height * TILE - vh) / 2;
  }

  // ---------- rendering ----------
  render(now) {
    const ctx = this.ctx, w = this.world; if (!w) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const z = this.zoom;
    const camX = this.camera.x, camY = this.camera.y;

    // sky gradient (drawn unscaled, fills the whole canvas)
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, '#7fc7ef'); g.addColorStop(1, '#bfe3f5');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);

    // everything below is drawn in world space, scaled by the zoom factor
    ctx.save();
    ctx.scale(z, z);

    const x0 = Math.max(0, Math.floor(camX / TILE));
    const y0 = Math.max(0, Math.floor(camY / TILE));
    const x1 = Math.min(w.width - 1, Math.floor((camX + cw / z) / TILE));
    const y1 = Math.min(w.height - 1, Math.floor((camY + ch / z) / TILE));

    // background tiles (dimmed)
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const bg = w.bg[ty * w.width + tx];
      if (!bg || !ITEMS[bg]) continue;
      const sx = tx * TILE - camX, sy = ty * TILE - camY;
      const sp = tileSprite(bg);
      if (sp) ctx.drawImage(sp, sx, sy, TILE, TILE);
      else ctx.fillStyle = shade(ITEMS[bg].color, -0.45), ctx.fillRect(sx, sy, TILE, TILE);
      ctx.fillStyle = 'rgba(8,10,26,.5)'; ctx.fillRect(sx, sy, TILE, TILE); // darken background layer
    }

    // foreground tiles
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const i = ty * w.width + tx;
      const fg = w.fg[i];
      if (!fg) continue;
      const sx = tx * TILE - camX, sy = ty * TILE - camY;
      this.drawTile(ctx, fg, sx, sy, w.data[i], now);
      const fx = this.breakFx.get(tx + ',' + ty);
      if (fx) {
        if (now - fx.t > BREAK_RESET_MS) this.breakFx.delete(tx + ',' + ty); // recovered
        else if (fx.hardness !== Infinity) this.drawCracks(ctx, sx, sy, fx.hits / fx.hardness);
      }
    }

    // drops (floating item icons at the broken block's position)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const d of this.drops.values()) {
      const bob = Math.sin(now / 300 + d.id) * 3;
      const sx = d.x - camX, sy = d.y - camY + bob;
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.beginPath(); ctx.ellipse(sx, sy + 13, 9, 4, 0, 0, 7); ctx.fill();
      const sp = dropSprite(d.item);
      if (sp) ctx.drawImage(sp, sx - 12, sy - 12, 24, 24);
      else { ctx.font = '20px serif'; ctx.fillStyle = '#fff'; ctx.fillText(ITEMS[d.item] ? ITEMS[d.item].icon : '❔', sx, sy); }
      if (d.count > 1) {
        ctx.font = 'bold 11px sans-serif'; ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
        ctx.strokeText('x' + d.count, sx + 12, sy + 11);
        ctx.fillText('x' + d.count, sx + 12, sy + 11);
      }
    }

    // other players
    for (const o of this.others.values()) this.drawCharacter(ctx, o.x - camX, o.y - camY, o.dir, o.anim, o.walkT, o.name, 1, 0, now - (o.punchAt || 0), o.punchAngle || 0, o.punchDist || 0, { dev: o.dev, equipped: o.equipped });

    // local player
    const meOpts = { dev: this.me.dev, equipped: this.me.equipped };
    if (this.local.dead) {
      const k = (now - this.local.deadAt) / RESPAWN_MS;
      this.drawCharacter(ctx, this.local.x - camX, this.local.y - camY - k * 40, this.local.dir, 'dead', 0, this.me.name, 1 - k * 0.8, k, 0, 0, 0, meOpts);
    } else {
      this.drawCharacter(ctx, this.local.x - camX, this.local.y - camY, this.local.dir, this.local.anim, this.local.walkT, this.me.name, 1, 0, now - this.local.punchAt, this.local.punchAngle, this.local.punchDist, meOpts);
    }

    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x - camX, p.y - camY, p.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // build target highlight (hidden in wrench mode)
    const t = this.pointerTile();
    if (t && this.selected !== 'wrench' && !this.ui.modalOpen()) {
      const sx = t.x * TILE - camX, sy = t.y * TILE - camY;
      ctx.lineWidth = 2;
      ctx.strokeStyle = this.inReach(t.x, t.y) ? 'rgba(255,255,255,.8)' : 'rgba(210,74,74,.8)';
      ctx.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
    }

    // growing-tree countdown bubble (when standing on/over a growing tree)
    if (!this.local.dead) {
      const tinfo = this.treeUnderPlayer();
      if (tinfo) {
        const secs = Math.ceil(tinfo.left / 1000);
        const label = `🌱 ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left`;
        this.drawBubble(ctx, this.local.x - camX, this.local.y - camY - 66, label);
      }
    }

    ctx.restore();   // end scaled world space

    // DOM wrench buttons over players (only while the wrench is selected)
    this.ui.updatePlayerTags([...this.others.values()], this.camera, this.selected === 'wrench', z);
  }

  drawBubble(ctx, x, y, text) {
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 18, h = 22;
    ctx.fillStyle = 'rgba(18,24,34,.94)'; ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, 8); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 5, y + h / 2 - 1); ctx.lineTo(x + 5, y + h / 2 - 1); ctx.lineTo(x, y + h / 2 + 6);
    ctx.closePath(); ctx.fillStyle = 'rgba(18,24,34,.94)'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
  }

  drawTile(ctx, id, x, y, data, now) {
    // tree (planted seed)
    if (id === '__tree__') return this.drawTree(ctx, x, y, data, now);

    // sprite-backed tiles (original pixel art for core blocks + the pack catalog)
    const sp = tileSprite(id);
    if (sp) { ctx.drawImage(sp, x, y, TILE, TILE); return; }

    if (id === 'door') return this.drawDoor(ctx, x, y);
    const it = ITEMS[id];
    if (!it) return;

    // procedural fallback (e.g. gold, or while a sprite is still loading)
    ctx.fillStyle = it.color || '#888';
    ctx.fillRect(x, y, TILE, TILE);
    // texture: darker bottom + speckle, lighter top edge
    ctx.fillStyle = shade(it.color, -0.18);
    ctx.fillRect(x, y + TILE - 6, TILE, 6);
    ctx.fillStyle = shade(it.color, 0.16);
    ctx.fillRect(x, y, TILE, 3);
    if (id === 'grass') { ctx.fillStyle = '#6fc34a'; ctx.fillRect(x, y, TILE, 8); }
    if (it.color2) { ctx.fillStyle = it.color2; ctx.fillRect(x + 6, y + 12, 5, 5); ctx.fillRect(x + 20, y + 19, 5, 5); }
    // inner border
    ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, TILE - 1, TILE - 1);

    // locks: overlay icon
    if (it.type === 'lock') {
      ctx.font = '18px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(it.icon, x + TILE / 2, y + TILE / 2);
    }
    if (id === 'sign') { ctx.font = '16px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('📜', x + TILE / 2, y + TILE / 2); }
  }

  drawDoor(ctx, x, y) {
    ctx.fillStyle = '#caa06a'; ctx.fillRect(x, y, TILE, TILE);          // frame
    ctx.fillStyle = '#f6f6f6'; ctx.fillRect(x + 4, y + 2, TILE - 8, TILE - 2); // white door
    ctx.strokeStyle = '#bdbdbd'; ctx.lineWidth = 1; ctx.strokeRect(x + 7, y + 6, TILE - 14, TILE - 10);
    ctx.fillStyle = '#f2c531'; ctx.beginPath(); ctx.arc(x + TILE - 9, y + TILE / 2, 2.4, 0, 7); ctx.fill(); // knob
  }

  drawTree(ctx, x, y, data, now) {
    const t = data && data.tree;
    const ready = t && (Date.now() - t.plantedAt >= t.growTime * 1000);
    const frac = t ? Math.min(1, (Date.now() - t.plantedAt) / (t.growTime * 1000)) : 0;
    const cx = x + TILE / 2;
    const h = 6 + frac * (TILE - 10);
    // trunk
    ctx.fillStyle = '#7a4a23';
    ctx.fillRect(cx - 2, y + TILE - h, 4, h);
    // foliage colored by the block it grows
    const blockId = t ? ITEMS[t.seed]?.seedOf : null;
    const col = blockId && ITEMS[blockId] ? ITEMS[blockId].color : '#3f8f3a';
    const r = 4 + frac * 9;
    ctx.fillStyle = ready ? col : shade(col, -0.1);
    ctx.beginPath(); ctx.arc(cx, y + TILE - h, r, 0, 7); ctx.fill();
    if (ready) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 250);
      ctx.strokeStyle = `rgba(242,197,49,${0.4 + pulse * 0.5})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, y + TILE - h, r + 3, 0, 7); ctx.stroke();
      ctx.font = '12px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('✨', cx, y + TILE - h - r - 6);
    }
  }

  drawCracks(ctx, x, y, frac) {
    ctx.fillStyle = `rgba(0,0,0,${0.12 + frac * 0.35})`;
    ctx.fillRect(x, y, TILE, TILE);
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1.4;
    const n = Math.ceil(frac * 4);
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(x + 4 + i * 7, y + 3);
      ctx.lineTo(x + 8 + i * 6, y + TILE - 4);
      ctx.stroke();
    }
  }

  drawCharacter(ctx, x, y, dir, anim, walkT, name, alpha = 1, deadK = 0, punchT = 0, punchAngle = 0, punchDist = 0, opts = {}) {
    const dev = !!opts.dev;
    const eq = opts.equipped || {};
    const H = TILE; // exactly one block tall

    // animation: legs/arms swing while walking, tuck on a jump
    let swing = 0;
    if (anim === 'walk') swing = Math.sin(walkT * 1.1) * 0.5;
    else if (anim === 'jump') swing = 0.5;

    // the punching arm is drawn FIRST (behind the body) in world space so its
    // fist reaches out past the torso toward the target
    if (anim === 'punch') {
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y);
      drawPunchArm(ctx, H, punchT, punchAngle, punchDist);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (anim === 'dead') ctx.rotate(deadK * 1.4);
    if (dir < 0) ctx.scale(-1, 1); // body faces the cursor side
    drawAvatar(ctx, H, eq, swing, anim);
    ctx.restore();

    // name tag — developers show a yellow, @-prefixed name
    if (name) {
      const label = dev && !String(name).startsWith('@') ? '@' + name : name;
      const nameFill = dev ? DEVELOPER_NAME_COLOR : '#fff';
      const nameStroke = dev ? DEVELOPER_NAME_STROKE : 'rgba(0,0,0,.6)';
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = nameFill; ctx.strokeStyle = nameStroke; ctx.lineWidth = dev ? 4 : 3;
      if (dev) { ctx.shadowColor = 'rgba(184,134,11,.35)'; ctx.shadowBlur = 4; }
      ctx.strokeText(label, x, y - H - 4);
      ctx.fillText(label, x, y - H - 4);
      ctx.restore();
    }
  }
}

// ---------- procedural layered avatar ----------
// Origin is at the feet (x = 0, y = 0), the figure extends up to y = -H, and
// `dir` has already been applied (the figure faces +x). Each equipment slot is
// drawn as its own layer over a plain-skin body, so "naked" is a real body and
// any shirt / pants / scarf / shoes / wings / pet can be added independently.
const SKIN = '#c0894f';   // bare-body colour (the "naked" look)

function drawAvatar(ctx, H, eq, swing, anim) {
  const hipY = -11, shoulderY = -21, headCY = -27, headR = 5.4;
  const legLen = 11, legW = 5, armLen = 10, armW = 4;
  const torsoTop = -22, torsoH = 12, torsoW = 13;

  const col = (slot, fallback) => {
    const it = eq[slot] && ITEMS[eq[slot]];
    return (it && it.color) || fallback;
  };
  const legColor = col('pants', SKIN);
  const torsoColor = col('shirt', SKIN);
  const shoeColor = eq.shoes ? col('shoes', '#5a3a1a') : null;

  if (eq.wings) {
    const wIt = ITEMS[eq.wings] || {};
    const frame = Math.floor(performance.now() / (wIt.frameMs || 500)) % (wIt.frames || 2);
    drawFeatheredWings(ctx, shoulderY, wIt.color || '#eef2f8', frame);
  }
  if (eq.pet) drawPet(ctx, col('pet', '#7bc24a'));

  // SIDE PROFILE (figure faces +x, nose on +x): the far arm is tucked behind
  // the torso (near centre, barely visible), the near arm is drawn over the
  // torso on the −x side (the side away from the face). This makes the facing
  // and the front/back hands unambiguous instead of a symmetric two-arm pose.
  drawLimb(ctx, -3, hipY, legLen, legW, -swing, shade(legColor, -0.14), shoeColor); // far leg
  drawLimb(ctx, 2, shoulderY + 1, armLen - 1, armW, swing, shade(SKIN, -0.18), null); // far arm (behind torso)

  // torso
  ctx.fillStyle = torsoColor;
  roundRect(ctx, -torsoW / 2, torsoTop, torsoW, torsoH, 4); ctx.fill();

  // near-side limbs (drawn over the torso)
  drawLimb(ctx, 3, hipY, legLen, legW, swing, legColor, shoeColor);              // near leg
  if (anim !== 'punch') drawLimb(ctx, -5, shoulderY + 1, armLen, armW, -swing, SKIN, null); // near/front arm

  if (eq.scarf) { ctx.fillStyle = col('scarf', '#d24a4a'); roundRect(ctx, -torsoW / 2 - 1, torsoTop - 2, torsoW + 2, 4, 2); ctx.fill(); }

  // head drawn as a clear SIDE PROFILE so facing is unambiguous (faces +x):
  // skin head, hair covering top + back (−x), a nose poking out front (+x),
  // and a single eye near the front.
  ctx.fillStyle = SKIN;
  ctx.beginPath(); ctx.arc(0, headCY, headR, 0, 7); ctx.fill();
  // hair: cap over the top and the back half
  ctx.fillStyle = '#3a2a1a';
  ctx.beginPath();
  ctx.arc(0, headCY, headR + 0.3, Math.PI * 0.62, Math.PI * 1.95);
  ctx.lineTo(0, headCY - 1);
  ctx.closePath(); ctx.fill();
  // nose on the front edge
  ctx.fillStyle = shade(SKIN, -0.12);
  ctx.beginPath();
  ctx.moveTo(headR - 1, headCY - 0.5);
  ctx.lineTo(headR + 1.8, headCY + 1);
  ctx.lineTo(headR - 1, headCY + 2.2);
  ctx.closePath(); ctx.fill();
  // eye near the front
  ctx.fillStyle = '#2b2b33';
  ctx.beginPath(); ctx.arc(headR * 0.42, headCY - 0.6, 1, 0, 7); ctx.fill();
}

// a rounded-rect limb that hangs from a pivot and rotates by `angle`
function drawLimb(ctx, px, py, len, w, angle, color, shoeColor) {
  ctx.save(); ctx.translate(px, py); ctx.rotate(angle);
  ctx.fillStyle = color; roundRect(ctx, -w / 2, 0, w, len, w * 0.4); ctx.fill();
  if (shoeColor) { ctx.fillStyle = shoeColor; roundRect(ctx, -w / 2 - 0.6, len - 2.4, w + 2, 3.4, 1.4); ctx.fill(); }
  ctx.restore();
}

// A SYMMETRIC feathered wing pair, mounted on the back and spreading up and out
// to BOTH sides (the classic winged-back look). Animated: `frame` toggles the
// spread so the wings flap. Drawn behind the body.
function drawFeatheredWings(ctx, shoulderY, color, frame) {
  const ay = shoulderY + 2;
  const spread = frame === 0 ? 1 : 0.82;          // flap: up-beat vs down-beat
  drawWing(ctx, 0, ay, -1, spread, color);        // left wing
  drawWing(ctx, 0, ay, 1, spread, color);         // right wing
}

// one wing for side = ±1 (mirrored), a soft membrane with layered feathers
// fanning from straight-up out to the side
function drawWing(ctx, ax, ay, side, spread, color) {
  const dark = shade(color, -0.36), light = shade(color, 0.30);
  ctx.save();
  ctx.translate(ax, ay);
  ctx.scale(side, 1);

  // membrane base for solidity
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(0, 1);
  ctx.quadraticCurveTo(9 * spread, -11 * spread, 17 * spread, -3 * spread);
  ctx.quadraticCurveTo(12, 6, 0, 5);
  ctx.closePath(); ctx.fill();

  // layered feathers: from up (top of wing) fanning out to the side
  const n = 6;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);                          // 0 = top/inner, 1 = outer
    const ang = -Math.PI / 2 + (0.28 + t * 1.05) * spread;
    const len = 8 + Math.sin((t + 0.12) * Math.PI * 0.9) * 9;
    const w = 4.4 + Math.sin(t * Math.PI) * 2.2;
    drawFeather(ctx, 0, 0, ang, len, w, i % 2 ? color : light, dark);
  }
  ctx.restore();
}

// one feather: a pointed shape from its base to a tip at distance `len`
function drawFeather(ctx, x, y, angle, len, w, color, edge) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = color; ctx.strokeStyle = edge; ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.55, -w / 2, len, 0);
  ctx.quadraticCurveTo(len * 0.55, w / 2, 0, 0);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function drawPet(ctx, color) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(-13, -6, 4.5, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(-15.5, -9, 2.6, 0, 7); ctx.fill();
  ctx.fillStyle = '#2b2b33';
  ctx.beginPath(); ctx.arc(-16.4, -9.4, 0.7, 0, 7); ctx.fill();
}

// ---------- helpers ----------
function mkOther(p) { return { id: p.id, name: p.name, dev: !!p.dev, equipped: p.equipped || {}, x: p.x, y: p.y, tx: p.x, ty: p.y, dir: p.dir || 1, anim: p.anim || 'idle', walkT: 0, punchAt: 0, punchAngle: 0, punchDist: 0, punchSeq: p.punchSeq ?? 0 }; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// Big comically-oversized punching fist with a forearm that tapers from the
// fist down to roughly torso width, shot from the chest toward `angle` and
// reaching out to `dist` px. The extension over time IS the animation.
function drawPunchArm(ctx, H, punchT, angle, dist) {
  const phase = clamp(punchT / 220, 0, 1);
  const reach = Math.sin(phase * Math.PI) * dist;   // 0 -> dist -> 0
  const fist = H * 0.8;                              // fist ~ 0.8 of a block
  const wBody = H * 0.42;                            // forearm width at the torso (~torso width)
  const wEnd = fist * 0.6;                           // forearm width where it meets the fist
  const len = Math.max(0, reach - fist * 0.35);      // forearm stops just behind the fist
  const SKIN = '#e3bd8e', SHADE = '#c99a6c';         // "back" hand = a touch darker

  ctx.save();
  ctx.translate(0, -H * 0.55);                       // chest origin
  ctx.rotate(angle);                                 // +x points along the punch

  // tapered forearm (wide near the fist, narrowing to torso width at the body)
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.moveTo(0, -wBody / 2); ctx.lineTo(len, -wEnd / 2);
  ctx.lineTo(len, wEnd / 2); ctx.lineTo(0, wBody / 2);
  ctx.closePath(); ctx.fill();

  // the big fist
  const cx = reach;
  ctx.fillStyle = SKIN; roundRect(ctx, cx - fist / 2, -fist / 2, fist, fist, fist * 0.22); ctx.fill();
  ctx.fillStyle = SHADE; roundRect(ctx, cx - fist / 2, fist / 2 - fist * 0.16, fist, fist * 0.16, fist * 0.12); ctx.fill();
  ctx.strokeStyle = SHADE; ctx.lineWidth = 2; ctx.lineCap = 'round'; // knuckle creases
  for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(cx - fist * 0.06, k * fist * 0.22); ctx.lineTo(cx + fist * 0.34, k * fist * 0.22); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,.28)'; roundRect(ctx, cx - fist * 0.34, -fist * 0.34, fist * 0.3, fist * 0.24, 3); ctx.fill(); // highlight
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function shade(hex, amt) {
  if (!hex || hex[0] !== '#') return hex || '#888';
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  if (amt > 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= (1 + amt); g *= (1 + amt); b *= (1 + amt); }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
