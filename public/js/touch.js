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

// One finger on the canvas aims/builds; TWO fingers pinch to zoom. Other thumbs
// on the movement/jump buttons aren't on the canvas, so they don't interfere.
function wireWorldTaps(game) {
  const canvas = game.canvas;
  const pts = new Map();   // active canvas pointerId -> {x, y}
  let buildId = null;
  let pinchDist = 0;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const clearBuild = () => { buildId = null; mouse.left = false; mouse.right = false; mouse.sx = -9999; mouse.sy = -9999; };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;  // desktop mouse uses its own handlers
    e.preventDefault();
    const p = local(e); pts.set(e.pointerId, p);
    if (pts.size >= 2) { clearBuild(); pinchDist = dist(); return; }  // start pinch
    // single finger -> build / aim
    buildId = e.pointerId;
    mouse.sx = p.x; mouse.sy = p.y;
    const sel = game.selected;
    if (sel === 'wrench') return;                          // wrench uses its own buttons
    if (sel && isPlaceable(sel)) mouse.right = true;
    else mouse.left = true;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e); pts.set(e.pointerId, p);
    if (pts.size >= 2) {                                   // pinch -> zoom
      const d = dist();
      if (pinchDist > 0 && d > 0) game.zoomBy(d / pinchDist);
      pinchDist = d;
      return;
    }
    if (e.pointerId === buildId) { mouse.sx = p.x; mouse.sy = p.y; }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (e.pointerId === buildId) clearBuild();
    if (pts.size < 2) pinchDist = 0;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}
