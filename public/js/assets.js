// Sprite assets (Kenney "Platformer Art Complete Pack", CC0 / public domain).
// Tiles/items are loaded LAZILY the first time they're drawn — important since
// the full catalog is ~875 sprites. Each item's path lives on ITEMS[id].sprite.
// The player avatar's layered parts are small and preloaded up front.
import { ITEMS } from './shared/items.js';

const cache = {};       // item id -> Image | null
const playerParts = {}; // layered part name -> Image

const PLAYER_PARTS = [
  'right_leg_walk', 'left_arm', 'right_arm', 'left_leg_walk',
  'torso', 'head', 'eyes', 'mouth',
];

function load(src) { const i = new Image(); i.src = src; return i; }
function ready(i) { return !!(i && i.complete && i.naturalWidth > 0); }

export function preloadPlayer() {
  for (const p of PLAYER_PARTS) playerParts[p] = load(`assets/player/new/${p}.png`);
}

export function playerPartSprite(name) { return ready(playerParts[name]) ? playerParts[name] : null; }

export function tileSprite(id) {
  if (!(id in cache)) {
    const it = ITEMS[id];
    cache[id] = it && it.sprite ? load(it.sprite) : null;
  }
  const i = cache[id];
  return ready(i) ? i : null;
}

// Animated sprite sheet (a horizontal strip of 16×16 frames) for custom items
// that declare `sheet` + `frames`. Cached separately from the single icon sprite.
const sheets = {};
export function sheetSprite(id) {
  if (!(id in sheets)) {
    const it = ITEMS[id];
    sheets[id] = it && it.sheet ? load(it.sheet) : null;
  }
  const i = sheets[id];
  return ready(i) ? i : null;
}

// drops draw the same sprite as the block/item they represent
export const dropSprite = tileSprite;

// URL for DOM <img> icons (shop / trade); null => fall back to emoji
export function iconUrl(id) { return (ITEMS[id] && ITEMS[id].sprite) || null; }
