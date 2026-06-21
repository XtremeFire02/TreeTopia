// Loads Sprite Studio custom items from the server and merges them into the
// live item registry. Called at boot and again whenever the shop opens, so
// freshly-saved items show up without reloading the whole app.
import { ITEMS } from './shared/items.js';
import { CUSTOM_ITEMS } from './shared/custom-items.js';
import { resolveServerUrl } from './net.js';

export function customBase() {
  try { return resolveServerUrl().replace(/^ws/, 'http').replace(/\/$/, ''); } catch { return ''; }
}

export async function loadCustomItems() {
  const base = customBase();
  try {
    const r = await fetch(base + '/api/custom-items');
    if (!r.ok) return;
    const data = await r.json();
    for (const id in data) {
      const def = { ...data[id] };
      for (const k of ['sprite', 'sheet']) {
        if (def[k] && !/^https?:/i.test(def[k])) def[k] = base + (def[k][0] === '/' ? '' : '/') + def[k];
      }
      ITEMS[id] = { ...(ITEMS[id] || {}), ...def };
      CUSTOM_ITEMS[id] = def;   // so the shop's Custom section + search-dedupe can see it
    }
  } catch { /* offline or none — game still works with built-in items */ }
}
