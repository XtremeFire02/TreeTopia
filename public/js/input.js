// Keyboard + mouse state. Mouse is tracked in screen pixels; the game loop
// converts to world/tile coordinates using the current camera.
export const keys = {};
export const mouse = { sx: 0, sy: 0, left: false, right: false };
export let typing = false;
export function setTyping(v) { typing = v; }

const MOVE_KEYS = new Set([
  'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's', ' ',
]);

export function initInput(canvas, hooks = {}) {
  window.addEventListener('keydown', (e) => {
    // let text fields handle their own keys (login, world name, admin, chat…)
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const k = e.key.toLowerCase();
    if (typing) {
      // let the chat / text inputs handle keys; only Escape bubbles
      if (k === 'escape' && hooks.onEscape) hooks.onEscape();
      return;
    }
    if (MOVE_KEYS.has(k)) e.preventDefault();
    keys[k] = true;
    if (hooks.onKey) hooks.onKey(k, e);
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.sx = e.clientX - r.left;
    mouse.sy = e.clientY - r.top;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) mouse.left = true;
    if (e.button === 2) mouse.right = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouse.left = false;
    if (e.button === 2) mouse.right = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}
