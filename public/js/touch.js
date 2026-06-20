// On-screen touch controls for mobile play. Drives the SAME `keys` / `mouse`
// state the desktop input uses, so the game loop needs no special-casing:
//   • left / right buttons   -> hold to walk
//   • jump button            -> press to jump (edge-triggered, like Space)
//   • BG toggle              -> place into the background layer (Shift on desktop)
//   • tapping the world       -> break (fist/tool selected) or place (block selected)
import { keys, mouse } from './input.js';
import { isPlaceable } from './shared/items.js';

export function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
}

export function initTouch(game) {
  if (!isTouchDevice()) return;
  document.body.classList.add('touch');

  const controls = document.getElementById('touchControls');
  if (controls) controls.classList.remove('hidden');

  bindHold(document.querySelector('#touchControls [data-dir="left"]'), 'arrowleft');
  bindHold(document.querySelector('#touchControls [data-dir="right"]'), 'arrowright');
  bindHold(document.querySelector('#touchControls [data-jump]'), ' ');

  // punch button: hold to keep breaking the tile in front of the player
  const punchBtn = document.querySelector('#touchControls [data-punch]');
  if (punchBtn) {
    const set = (v) => (e) => { e.preventDefault(); game.punchHeld = v; };
    punchBtn.addEventListener('pointerdown', (e) => { try { punchBtn.setPointerCapture(e.pointerId); } catch {} set(true)(e); });
    punchBtn.addEventListener('pointerup', set(false));
    punchBtn.addEventListener('pointercancel', set(false));
    punchBtn.addEventListener('pointerleave', set(false));
  }

  const bgBtn = document.querySelector('#touchControls [data-bg]');
  if (bgBtn) {
    bgBtn.addEventListener('click', () => {
      game.touchBgMode = !game.touchBgMode;
      bgBtn.classList.toggle('on', game.touchBgMode);
    });
  }

  wireWorldTaps(game);

  // one-time hint once the player is actually in a world
  document.addEventListener('enteredWorld', () => {
    if (game.ui) game.ui.toast('◀ ▶ move · ⬆ jump · tap the world to build');
  }, { once: true });
}

// Hold a button to keep a key "down"; release/cancel clears it.
function bindHold(btn, key) {
  if (!btn) return;
  const down = (e) => { e.preventDefault(); keys[key] = true; };
  const up = (e) => { e.preventDefault(); keys[key] = false; };
  btn.addEventListener('pointerdown', (e) => { try { btn.setPointerCapture(e.pointerId); } catch {} down(e); });
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
}

// A finger on the canvas aims and triggers building. Only one "build finger" is
// tracked at a time so the other thumb can keep moving/jumping at the same time.
function wireWorldTaps(game) {
  const canvas = game.canvas;
  let buildId = null;

  const setPos = (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.sx = e.clientX - r.left;
    mouse.sy = e.clientY - r.top;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;  // desktop mouse uses its own handlers
    if (buildId !== null) return;
    e.preventDefault();
    buildId = e.pointerId;
    setPos(e);
    const sel = game.selected;
    // a placeable block places; everything else (fist, etc.) breaks. The wrench
    // inspects via its own on-screen buttons, so it triggers no world action.
    if (sel === 'wrench') return;
    if (sel && isPlaceable(sel)) mouse.right = true;
    else mouse.left = true;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== buildId) return;
    setPos(e);  // drag to keep breaking / re-aim toward the finger
  });

  const end = (e) => {
    if (e.pointerId !== buildId) return;
    buildId = null;
    mouse.left = false;
    mouse.right = false;
    mouse.sx = -9999; mouse.sy = -9999;  // park the cursor so no highlight lingers
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}
