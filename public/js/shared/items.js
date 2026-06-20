// Shared item / block / seed / lock database.
// Used by the server (authoritative logic) and the client (rendering + UI).
//
// Item schema:
//   id        unique string id
//   name      display name
//   type      'block' | 'seed' | 'lock' | 'tool' | 'currency' | 'special'
//   icon      emoji used in inventory / drops
//   color     primary tile color (blocks)
//   color2    secondary/pattern color (blocks)
//   solid     does it block player movement (blocks)
//   hardness  hits required to break (blocks)
//   seedOf    block id this seed grows into (seeds)
//   growTime  seconds for a planted seed to mature (seeds)
//   drops     { block, seed, gemMin, gemMax } produced when the BLOCK is broken
//   price     gem cost in the shop (omitted = not buyable)
//   rarity    1..n used for splice odds / value
//   lock      { scope:'world'|'small'|'huge', radius } for locks
//   sprite    path to a PNG asset (overrides procedural drawing)
//   hazard    'lava' | 'spike' — touching it kills the player

import { PACK_ITEMS } from './pack-items.js';

export const ITEMS = {
  // ---- currency ----
  gem: { id: 'gem', name: 'Gem', type: 'currency', icon: '💎' },

  // ---- the world spawn door ----
  door: {
    id: 'door', name: 'White Door', type: 'special', icon: '🚪',
    color: '#f4f4f4', color2: '#cfcfcf', solid: false, hardness: 6,
    drops: { block: 'door', gemMin: 0, gemMax: 0 },
  },
  sign: {
    id: 'sign', name: 'Sign', type: 'special', icon: '📜',
    color: '#caa472', color2: '#a3825a', solid: false, hardness: 3,
    drops: { block: 'sign', gemMin: 0, gemMax: 0 }, price: 25,
  },

  // ---- bedrock (unbreakable floor) ----
  bedrock: {
    id: 'bedrock', name: 'Bedrock', type: 'block', icon: '⬛',
    color: '#2b2b33', color2: '#1d1d23', solid: true, hardness: Infinity,
    drops: { gemMin: 0, gemMax: 0 },
  },

  // ---- natural / farmable blocks ----
  dirt: {
    id: 'dirt', name: 'Dirt', type: 'block', icon: '🟫',
    color: '#7a4a23', color2: '#653c1b', solid: true, hardness: 4, rarity: 1,
    drops: { block: 'dirt', seed: 'dirt_seed', gemMin: 0, gemMax: 2 },
  },
  grass: {
    id: 'grass', name: 'Grass', type: 'block', icon: '🟩',
    color: '#5aa83a', color2: '#7a4a23', solid: true, hardness: 4, rarity: 1,
    drops: { block: 'grass', seed: 'grass_seed', gemMin: 0, gemMax: 2 },
  },
  rock: {
    id: 'rock', name: 'Rock', type: 'block', icon: '🪨',
    color: '#8a8d93', color2: '#6f7278', solid: true, hardness: 6, rarity: 2,
    drops: { block: 'rock', seed: 'rock_seed', gemMin: 1, gemMax: 3 },
  },
  sand: {
    id: 'sand', name: 'Sand', type: 'block', icon: '🟨',
    color: '#e3d28a', color2: '#cdbb6f', solid: true, hardness: 3, rarity: 1,
    drops: { block: 'sand', seed: 'sand_seed', gemMin: 0, gemMax: 2 },
  },
  wood: {
    id: 'wood', name: 'Wood Block', type: 'block', icon: '🪵',
    color: '#8a5a2b', color2: '#6e451f', solid: true, hardness: 4, rarity: 2,
    drops: { block: 'wood', seed: 'wood_seed', gemMin: 0, gemMax: 2 },
  },
  leaves: {
    id: 'leaves', name: 'Leaves', type: 'block', icon: '🍃',
    color: '#3f8f3a', color2: '#347a30', solid: true, hardness: 2, rarity: 2,
    drops: { block: 'leaves', seed: 'leaves_seed', gemMin: 0, gemMax: 1 },
  },
  brick: {
    id: 'brick', name: 'Brick', type: 'block', icon: '🧱',
    color: '#9c4a3c', color2: '#7d3a2f', solid: true, hardness: 7, rarity: 3,
    drops: { block: 'brick', seed: 'brick_seed', gemMin: 1, gemMax: 4 },
  },
  glass: {
    id: 'glass', name: 'Glass', type: 'block', icon: '🟦',
    color: '#9fd6e6', color2: '#7fc0d4', solid: true, hardness: 3, rarity: 3,
    drops: { block: 'glass', seed: 'glass_seed', gemMin: 1, gemMax: 3 },
  },
  lava: {
    id: 'lava', name: 'Lava', type: 'block', icon: '🌋',
    color: '#e2591f', color2: '#b53d12', solid: true, hardness: 5, rarity: 3,
    drops: { block: 'lava', seed: 'lava_seed', gemMin: 1, gemMax: 4 },
  },
  gold: {
    id: 'gold', name: 'Gold Block', type: 'block', icon: '🟧',
    color: '#f2c531', color2: '#d9a814', solid: true, hardness: 9, rarity: 5,
    drops: { block: 'gold', seed: 'gold_seed', gemMin: 3, gemMax: 8 },
  },

  // ---- seeds (one per farmable block) ----
  dirt_seed:   seed('dirt',   8,  10),
  grass_seed:  seed('grass',  8,  10),
  rock_seed:   seed('rock',   20, 18),
  sand_seed:   seed('sand',   8,  10),
  wood_seed:   seed('wood',   18, 16),
  leaves_seed: seed('leaves', 18, 16),
  brick_seed:  seed('brick',  60, 35),
  glass_seed:  seed('glass',  60, 35),
  lava_seed:   seed('lava',   80, 40),
  gold_seed:   seed('gold',   250, 80),

  // ---- locks ----
  world_lock: {
    id: 'world_lock', name: 'World Lock', type: 'lock', icon: '🔒',
    color: '#3a7bd5', color2: '#2b5fa6', solid: true, hardness: Infinity,
    price: 500, lock: { scope: 'world', radius: 0 },
  },
  small_lock: {
    id: 'small_lock', name: 'Small Lock', type: 'lock', icon: '🔑',
    color: '#d59f3a', color2: '#a67a2b', solid: true, hardness: Infinity,
    price: 100, lock: { scope: 'small', radius: 4 },
  },
  huge_lock: {
    id: 'huge_lock', name: 'Huge Lock', type: 'lock', icon: '🗝️',
    color: '#9b3ad5', color2: '#762ba6', solid: true, hardness: Infinity,
    price: 1000, lock: { scope: 'huge', radius: 12 },
  },

  // ---- permanent tools (always present, can't be removed/traded) ----
  fist: { id: 'fist', name: 'Fist', type: 'tool', icon: '✊', permanent: true },
  wrench: { id: 'wrench', name: 'Wrench', type: 'tool', icon: '🔧', permanent: true },

  // ---- clothing / equipment (equip from the inventory; never placed) ----
  // Each item names a `slot`; the avatar renders whatever is equipped per slot.
  // `color` drives the procedural rendering. Add more items per class freely.
  basic_shirt: {
    id: 'basic_shirt', name: 'Cotton Shirt', type: 'clothing', slot: 'shirt',
    icon: '👕', color: '#4f8be0',
  },
  basic_pants: {
    id: 'basic_pants', name: 'Cotton Pants', type: 'clothing', slot: 'pants',
    icon: '👖', color: '#3a4a66',
  },
  // legacy: kept so old saves that reference it still resolve (now a shirt)
  adventurer_outfit: {
    id: 'adventurer_outfit', name: 'Adventurer Shirt', type: 'clothing', slot: 'shirt',
    icon: '🧥', color: '#8a5a2b',
  },
  // animated wings: `render: 'eagle'` + a 2-frame flap toggled every frameMs
  crimson_eagle_wings: {
    id: 'crimson_eagle_wings', name: 'Crimson Eagle Wings', type: 'clothing', slot: 'wings',
    icon: '🦅', color: '#c01622', render: 'eagle', frames: 2, frameMs: 500,
    price: 2500, category: 'Wings',
  },

  // ---- equippable effect items ----
  // Angel Wings: a wings-slot garment that ALSO grants double-jump while owned.
  wings: {
    id: 'wings', name: 'Angel Wings', type: 'clothing', slot: 'wings', icon: '🪽',
    effect: 'double_jump', color: '#eaf2ff', frames: 2, frameMs: 600, price: 800, category: 'Wings',
  },
  cyclopean_visor: { id: 'cyclopean_visor', name: 'Cyclopean Visor', type: 'effect', icon: '👁️', effect: 'long_punch', price: 600 },
};

// ---- attach sprites to core items + merge the full 875-sprite pack catalog ----
const CORE_SPRITES = {
  dirt: 'assets/tiles/dirt.png', grass: 'assets/tiles/grass.png', rock: 'assets/tiles/rock.png',
  sand: 'assets/tiles/sand.png', wood: 'assets/tiles/wood.png', leaves: 'assets/tiles/leaves.png',
  brick: 'assets/tiles/brick.png', glass: 'assets/tiles/glass.png', lava: 'assets/tiles/lava.png',
  gold: 'assets/tiles/gold.png', bedrock: 'assets/tiles/bedrock.png', sign: 'assets/tiles/sign.png',
  door: 'assets/tiles/door.png',
  world_lock: 'assets/tiles/world_lock.png', small_lock: 'assets/tiles/small_lock.png',
  huge_lock: 'assets/tiles/huge_lock.png', gem: 'assets/items/gem.png',
};
for (const [k, v] of Object.entries(CORE_SPRITES)) if (ITEMS[k]) ITEMS[k].sprite = v;
for (const k in ITEMS) if (ITEMS[k].type === 'seed') ITEMS[k].sprite = 'assets/items/seed.png';
if (ITEMS.lava) ITEMS.lava.hazard = 'lava';
// merge — core gameplay items take precedence over pack duplicates
for (const k in PACK_ITEMS) if (!ITEMS[k]) ITEMS[k] = PACK_ITEMS[k];

// helper to build a seed definition
function seed(blockId, price, growTime) {
  return {
    id: blockId + '_seed',
    name: titleCase(blockId) + ' Seed',
    type: 'seed', icon: '🌱',
    seedOf: blockId, growTime, price,
  };
}

function titleCase(s) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- splicing recipes ----
// Combine two seeds to discover a new seed. Key is the two seed ids sorted & joined.
export const SPLICE_RECIPES = {
  [key('dirt_seed', 'rock_seed')]: 'brick_seed',
  [key('sand_seed', 'lava_seed')]: 'glass_seed',
  [key('wood_seed', 'grass_seed')]: 'leaves_seed',
  [key('rock_seed', 'lava_seed')]: 'gold_seed',
  [key('dirt_seed', 'grass_seed')]: 'sand_seed',
  [key('grass_seed', 'rock_seed')]: 'wood_seed',
};

export function spliceResult(a, b) {
  return SPLICE_RECIPES[key(a, b)] || null;
}

function key(a, b) {
  return [a, b].sort().join('+');
}

// ---- shop catalog (ordered) ----
export const SHOP = [
  'small_lock', 'world_lock', 'huge_lock',
  'dirt_seed', 'grass_seed', 'sand_seed', 'rock_seed', 'wood_seed',
  'leaves_seed', 'brick_seed', 'glass_seed', 'lava_seed', 'gold_seed',
  'sign',
];

// Full buyable catalog (core + entire pack), used by the in-game shop.
export function shopCatalog() {
  return Object.values(ITEMS)
    .filter((it) => it.price != null)
    .map((it) => ({
      id: it.id, name: it.name, price: it.price, type: it.type,
      category: it.category || coreCategory(it),
      sprite: it.sprite || null, icon: it.icon || null,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.price - b.price || a.name.localeCompare(b.name));
}
function coreCategory(it) {
  if (it.type === 'lock') return 'Core · Locks';
  if (it.type === 'seed') return 'Core · Seeds';
  return 'Core · Items';
}

export function categories() {
  const set = new Set();
  for (const c of shopCatalog()) set.add(c.category);
  return [...set].sort();
}

// ---- helpers ----
// Permanent tools every player always has.
export const PERMANENT = ['fist', 'wrench'];

// Clothing every player starts owning (so they can dress themselves). They are
// NOT auto-equipped — players spawn naked and equip from the inventory.
export const STARTER_CLOTHING = ['basic_shirt', 'basic_pants'];

// Equipment slots, drawn back-to-front in roughly this order by the avatar.
// Add more clothing items that reference any of these slots at any time.
export const EQUIP_SLOTS = ['wings', 'pet', 'shoes', 'pants', 'shirt', 'scarf'];

// Is this an equippable clothing item?
export function isClothing(id) {
  const it = ITEMS[id];
  return !!(it && it.type === 'clothing');
}

// Is an effect (e.g. 'double_jump', 'long_punch') active for this inventory?
export function hasEffect(inv, effect) {
  for (const id in inv) if (inv[id] > 0 && ITEMS[id] && ITEMS[id].effect === effect) return true;
  return false;
}

// Items that can actually be placed in the world.
export function isPlaceable(id) {
  const it = ITEMS[id];
  return !!(it && (it.type === 'block' || it.type === 'special' || it.type === 'seed' || it.type === 'lock'));
}

export function isBlockLike(id) {
  const it = ITEMS[id];
  return it && (it.type === 'block' || it.type === 'lock' || it.type === 'special');
}

export function isSolid(id) {
  const it = ITEMS[id];
  return !!(it && it.solid);
}

// Roll the drop produced when a block is broken (Inclusive OR: can yield
// several outcomes from a single break — block, seed and gems all possible).
export function rollDrops(blockId) {
  const it = ITEMS[blockId];
  const out = [];
  if (!it || !it.drops) return out;
  const d = it.drops;

  // The block itself comes back ~35% of the time.
  if (d.block && Math.random() < 0.35) out.push({ item: d.block, count: 1 });
  // A seed of the block ~30% of the time.
  if (d.seed && Math.random() < 0.30) out.push({ item: d.seed, count: 1 });
  // Gems.
  if (d.gemMax > 0) {
    const g = d.gemMin + Math.floor(Math.random() * (d.gemMax - d.gemMin + 1));
    if (g > 0) out.push({ item: 'gem', count: g });
  }
  // Guarantee at least something so breaking never feels empty.
  if (out.length === 0) {
    if (d.block) out.push({ item: d.block, count: 1 });
    else if (d.gemMax > 0) out.push({ item: 'gem', count: 1 });
  }
  return out;
}

// Roll what a fully grown tree gives when harvested (Inclusive OR: seeds
// AND/OR blocks).  Always yields at least one thing.
export function rollHarvest(seedId) {
  const seedDef = ITEMS[seedId];
  if (!seedDef || !seedDef.seedOf) return [];
  const blockId = seedDef.seedOf;
  const out = [];
  const blockCount = 1 + Math.floor(Math.random() * 3); // 1..3 blocks
  if (Math.random() < 0.85) out.push({ item: blockId, count: blockCount });
  if (Math.random() < 0.6) out.push({ item: seedId, count: 1 + Math.floor(Math.random() * 2) });
  if (out.length === 0) out.push({ item: blockId, count: 1 });
  return out;
}
