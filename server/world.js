// Authoritative world model: generation, tile access, lock permissions,
// planting/growth and (de)serialization for persistence + network.

import { WORLD_W, WORLD_H, SKY_ROWS, TILE } from '../public/js/shared/constants.js';
import { ITEMS } from '../public/js/shared/items.js';

export class World {
  constructor(name) {
    this.name = name.toUpperCase();
    this.width = WORLD_W;
    this.height = WORLD_H;
    this.fg = new Array(this.width * this.height).fill('');
    this.bg = new Array(this.width * this.height).fill('');
    this.data = {};            // tileIndex -> extra state (door / tree / lock)
    this.owner = null;         // world-lock owner (player name) or null = public
    this.admins = [];          // world-lock admins
    this.spawn = { tx: 0, ty: 0 };
    this.breaking = {};         // tileIndex -> { hits, last } (in-memory only)
    this.generate();
  }

  idx(x, y) { return y * this.width + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }

  getFg(x, y) { return this.inBounds(x, y) ? this.fg[this.idx(x, y)] : 'bedrock'; }
  getBg(x, y) { return this.inBounds(x, y) ? this.bg[this.idx(x, y)] : ''; }

  // ---- generation: a flat dirt world ----
  generate() {
    const ground = SKY_ROWS;            // grass surface row
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = this.idx(x, y);
        if (y < ground) {
          this.fg[i] = '';              // sky
          this.bg[i] = '';
        } else if (y === ground) {
          this.fg[i] = 'grass';
          this.bg[i] = 'dirt';
        } else if (y === this.height - 1) {
          this.fg[i] = 'bedrock';
          this.bg[i] = 'bedrock';
        } else {
          this.fg[i] = 'dirt';
          this.bg[i] = 'dirt';
        }
      }
    }
    // White door spawns at a random x, resting on the surface (in line w/ top layer).
    const doorX = 3 + Math.floor(Math.random() * (this.width - 6));
    const doorY = ground - 1;
    const di = this.idx(doorX, doorY);
    this.fg[di] = 'door';
    this.data[di] = { door: true, main: true };
    this.spawn = { tx: doorX, ty: doorY };
  }

  // ---- spawn position in pixels (player stands in front of the door) ----
  spawnPixel() {
    return {
      x: this.spawn.tx * TILE + TILE / 2,
      y: this.spawn.ty * TILE + TILE,
    };
  }

  // ---- lock / permission system ----
  // Returns the area-lock object governing this tile, or null.
  lockAt(x, y) {
    let best = null;
    for (const i in this.data) {
      const d = this.data[i];
      if (!d || !d.lock || d.lock.scope === 'world') continue;
      const lx = Number(i) % this.width;
      const ly = Math.floor(Number(i) / this.width);
      const r = d.lock.radius;
      if (x >= lx - r && x <= lx + r && y >= ly - r && y <= ly + r) {
        if (!best || d.lock.radius < best.lock.radius) best = d;
      }
    }
    return best;
  }

  canModify(playerName, x, y) {
    const areaLock = this.lockAt(x, y);
    if (areaLock) {
      return areaLock.lock.owner === playerName ||
             areaLock.lock.admins.includes(playerName);
    }
    if (this.owner) {
      return this.owner === playerName || this.admins.includes(playerName);
    }
    return true; // public world, no area lock
  }

  // Who governs a point (for UI messages). Returns {owner, admins} or null.
  ownerInfoAt(x, y) {
    const areaLock = this.lockAt(x, y);
    if (areaLock) return { owner: areaLock.lock.owner, admins: areaLock.lock.admins };
    if (this.owner) return { owner: this.owner, admins: this.admins };
    return null;
  }

  // ---- tile mutation ----
  setFg(x, y, id) { this.fg[this.idx(x, y)] = id; }

  clearTile(x, y) {
    const i = this.idx(x, y);
    this.fg[i] = '';
    delete this.breaking[i];
    if (this.data[i] && !this.data[i].lock) delete this.data[i];
  }

  // place a lock; returns true on success
  placeLock(playerName, x, y, lockId) {
    const def = ITEMS[lockId];
    if (!def || !def.lock) return false;
    const i = this.idx(x, y);
    if (this.fg[i]) return false; // need empty space (foreground)

    if (def.lock.scope === 'world') {
      // only ONE world lock per world — if it already has an owner, refuse
      if (this.owner) return false;
      this.owner = playerName;
      this.fg[i] = lockId;
      this.data[i] = { lock: { scope: 'world', owner: playerName, admins: this.admins } };
      return true;
    }
    // small / huge area lock — must be allowed to build here
    if (!this.canModify(playerName, x, y)) return false;
    this.fg[i] = lockId;
    this.data[i] = {
      lock: { scope: def.lock.scope, owner: playerName, admins: [], radius: def.lock.radius },
    };
    return true;
  }

  // ---- planting / trees ----
  plant(x, y, seedId) {
    const def = ITEMS[seedId];
    if (!def || !def.seedOf) return false;
    const i = this.idx(x, y);
    if (this.fg[i]) return false;
    this.fg[i] = '__tree__';
    this.data[i] = { tree: { seed: seedId, plantedAt: Date.now(), growTime: def.growTime } };
    return true;
  }

  treeReady(i) {
    const d = this.data[i];
    if (!d || !d.tree) return false;
    return Date.now() - d.tree.plantedAt >= d.tree.growTime * 1000;
  }

  // ---- serialization ----
  serialize() {
    return {
      name: this.name, width: this.width, height: this.height,
      fg: this.fg, bg: this.bg, data: this.data,
      owner: this.owner, admins: this.admins, spawn: this.spawn,
    };
  }

  static deserialize(obj) {
    const w = Object.create(World.prototype);
    w.name = obj.name; w.width = obj.width; w.height = obj.height;
    w.fg = obj.fg; w.bg = obj.bg; w.data = obj.data || {};
    w.owner = obj.owner || null; w.admins = obj.admins || [];
    w.spawn = obj.spawn; w.breaking = {};
    return w;
  }
}
