// Validates the merged item catalog (runs in Node — items.js has no browser deps).
import { ITEMS, shopCatalog, categories, hasEffect, isPlaceable, PERMANENT } from '../public/js/shared/items.js';

const ids = Object.keys(ITEMS);
console.log('Total items in ITEMS:', ids.length);
console.log('Shop catalog (buyable):', shopCatalog().length);
console.log('Categories:', categories().length);
console.log('Permanent tools:', PERMANENT.join(', '));

const withSprite = ids.filter((id) => ITEMS[id].sprite);
console.log('Items with a sprite path:', withSprite.length);

// spot checks
const checks = [
  ['dirt has sprite', !!ITEMS.dirt.sprite],
  ['wings grants double_jump', hasEffect({ wings: 1 }, 'double_jump')],
  ['visor grants long_punch', hasEffect({ cyclopean_visor: 1 }, 'long_punch')],
  ['fist not placeable', !isPlaceable('fist')],
  ['wrench not placeable', !isPlaceable('wrench')],
  ['a pack tile exists & placeable', ids.some((id) => ITEMS[id].sprite && ITEMS[id].sprite.includes('/pack/') && isPlaceable(id))],
  ['lava is a hazard', ITEMS.lava.hazard === 'lava'],
];
let bad = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) bad++; }
process.exit(bad ? 1 : 0);
