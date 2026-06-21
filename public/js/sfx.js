// Tiny WebAudio sound effects — synthesized, so there are no asset files to load.
// Mobile browsers only allow audio to start after a user gesture, so we lazily
// create the AudioContext and also unlock it on the first interaction.
let ac = null;
let unlocked = false;

function ctx() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

export function unlockAudio() {
  if (unlocked) return;
  const c = ctx();
  if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  g.gain.value = 0;                       // silent blip just to wake the context
  o.connect(g); g.connect(c.destination);
  o.start(); o.stop(c.currentTime + 0.01);
  unlocked = true;
}

// A short rising "boing" for jumps.
export function playJump() {
  const c = ctx(); if (!c) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(280, t);
  o.frequency.exponentialRampToValueAtTime(640, t + 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(g); g.connect(c.destination);
  o.start(t); o.stop(t + 0.2);
}

// A low percussive thud for punches (a quick down-sweep + a noise tick).
export function playPunch() {
  const c = ctx(); if (!c) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(190, t);
  o.frequency.exponentialRampToValueAtTime(65, t + 0.1);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  o.connect(g); g.connect(c.destination);
  o.start(t); o.stop(t + 0.15);

  // brief noise burst for the "impact" texture
  const dur = 0.05, buf = c.createBuffer(1, (c.sampleRate * dur) | 0, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const ns = c.createBufferSource(); ns.buffer = buf;
  const ng = c.createGain(); ng.gain.value = 0.12;
  ns.connect(ng); ng.connect(c.destination);
  ns.start(t);
}

// Unlock on the very first user interaction (idempotent; listeners self-remove).
['pointerdown', 'touchstart', 'keydown', 'click'].forEach((ev) => {
  const h = () => { unlockAudio(); };
  window.addEventListener(ev, h, { once: true, passive: true });
});
