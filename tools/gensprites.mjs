// Generates ORIGINAL Growtopia-style pixel-art sprites (not copies of any
// copyrighted assets) and writes them as PNGs. Dependency-free: hand-rolled
// PNG encoder on top of Node's zlib.
//
// Run:  node tools/gensprites.mjs
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const TILES = 'public/assets/tiles';
const ITEMS = 'public/assets/items';
const PLAYER = 'public/assets/player';
for (const d of [TILES, ITEMS, PLAYER]) fs.mkdirSync(d, { recursive: true });

// ---------------- PNG encoder ----------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(im) {
  const { w, h, buf } = im;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- tiny pixel canvas ----------------
const img = (w, h) => ({ w, h, buf: Buffer.alloc(w * h * 4) });
function px(im, x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const i = (y * im.w + x) * 4, a = c[3] === undefined ? 255 : c[3];
  if (a === 255) { im.buf[i] = c[0]; im.buf[i + 1] = c[1]; im.buf[i + 2] = c[2]; im.buf[i + 3] = 255; }
  else { // alpha blend over existing
    const ba = im.buf[i + 3] / 255, fa = a / 255, oa = fa + ba * (1 - fa);
    for (let k = 0; k < 3; k++) im.buf[i + k] = oa ? (c[k] * fa + im.buf[i + k] * ba * (1 - fa)) / oa : 0;
    im.buf[i + 3] = oa * 255;
  }
}
function rect(im, x, y, w, h, c) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(im, xx, yy, c); }
const mix = (a, b, t = 0.5) => [a[0] + (b[0] - a[0]) * t | 0, a[1] + (b[1] - a[1]) * t | 0, a[2] + (b[2] - a[2]) * t | 0, 255];
function rng(seed) { let s = (seed >>> 0) || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function save(dir, name, im) { fs.writeFileSync(path.join(dir, name + '.png'), encodePNG(im)); }

// chunky 32x32 block with speckle texture + edge shading
function block(base, dark, light, seed, speckle = 64) {
  const im = img(32, 32);
  rect(im, 0, 0, 32, 32, base);
  const r = rng(seed);
  for (let i = 0; i < speckle; i++) px(im, r() * 32, r() * 32, r() < 0.5 ? dark : light);
  rect(im, 0, 0, 32, 2, light);          // top highlight
  rect(im, 0, 30, 32, 2, dark);          // bottom shadow
  for (let y = 0; y < 32; y++) { px(im, 0, y, mix(base, light, .3)); px(im, 31, y, dark); }
  for (let x = 0; x < 32; x++) px(im, x, 31, dark);
  return im;
}

// ---------------- palette ----------------
const C = {
  dirt: ['#7a4a23', '#5c3717', '#8f5a2e'], grass: ['#57a83a', '#3f8029', '#74c24e'],
  rock: ['#8a8d93', '#686b71', '#a8abb1'], sand: ['#e3d28a', '#c7b364', '#efe2a8'],
  wood: ['#8a5a2b', '#6c441d', '#a06a34'], leaf: ['#3f9136', '#2d6b28', '#5cb350'],
  brick: ['#9c4a3c', '#7a382d', '#b85a4a'], glass: ['#bfe6f2', '#86c3d6', '#e8f8ff'],
  lava: ['#e2591f', '#b53d12', '#ffc24a'], gold: ['#f2c531', '#cf9c12', '#ffe277'],
  bed: ['#2c2c34', '#1c1c22', '#3c3c46'],
};
const hx = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];
const P = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v.map(hx)]));

// ---------------- tiles ----------------
save(TILES, 'dirt', block(P.dirt[0], P.dirt[1], P.dirt[2], 11));
save(TILES, 'rock', (() => { const im = block(P.rock[0], P.rock[1], P.rock[2], 22, 40); rect(im, 8, 10, 8, 2, P.rock[1]); rect(im, 18, 20, 7, 2, P.rock[1]); return im; })());
save(TILES, 'sand', block(P.sand[0], P.sand[1], P.sand[2], 33, 80));
save(TILES, 'leaves', block(P.leaf[0], P.leaf[1], P.leaf[2], 44, 90));
save(TILES, 'bedrock', (() => { const im = block(P.bed[0], P.bed[1], P.bed[2], 55, 50); rect(im, 6, 8, 9, 2, P.bed[1]); rect(im, 17, 18, 9, 2, P.bed[1]); return im; })());

// grass: green crown on a dirt body
save(TILES, 'grass', (() => {
  const im = block(P.dirt[0], P.dirt[1], P.dirt[2], 11);
  rect(im, 0, 0, 32, 11, P.grass[0]);
  rect(im, 0, 0, 32, 2, P.grass[2]);
  const r = rng(7); for (let i = 0; i < 26; i++) px(im, r() * 32, r() * 9, r() < .5 ? P.grass[1] : P.grass[2]);
  for (let x = 0; x < 32; x += 3) rect(im, x, 10, 1, 3, P.grass[1]); // blades hanging into dirt
  return im;
})());

// wood: vertical planks
save(TILES, 'wood', (() => {
  const im = block(P.wood[0], P.wood[1], P.wood[2], 12, 30);
  for (const x of [0, 10, 21, 31]) rect(im, x, 0, 1, 32, P.wood[1]);
  const r = rng(9); for (let i = 0; i < 26; i++) { const x = (r() * 32) | 0; rect(im, x, (r() * 32) | 0, 3, 1, P.wood[1]); }
  return im;
})());

// brick: offset courses
save(TILES, 'brick', (() => {
  const im = img(32, 32); rect(im, 0, 0, 32, 32, P.brick[0]);
  const mortar = mix(P.brick[1], [0, 0, 0, 255], .2);
  for (let y = 0; y < 32; y += 8) {
    rect(im, 0, y, 32, 1, mortar);
    const off = (y / 8) % 2 ? 0 : 8;
    for (let x = off; x < 32; x += 16) rect(im, x, y, 1, 8, mortar);
    rect(im, 0, y + 1, 32, 1, P.brick[2]); // top shine of each course
  }
  return im;
})());

// glass: translucent with a shine streak
save(TILES, 'glass', (() => {
  const im = img(32, 32); rect(im, 0, 0, 32, 32, [P.glass[0][0], P.glass[0][1], P.glass[0][2], 150]);
  for (let i = 0; i < 32; i++) { px(im, i, i, [255, 255, 255, 200]); px(im, i + 1, i, [255, 255, 255, 120]); }
  for (let y = 0; y < 32; y++) { px(im, 0, y, P.glass[1]); px(im, 31, y, P.glass[1]); }
  rect(im, 0, 0, 32, 2, [255, 255, 255, 180]); rect(im, 0, 30, 32, 2, P.glass[1]);
  return im;
})());

// lava: dark crust + glowing pools
save(TILES, 'lava', (() => {
  const im = block(P.lava[0], P.lava[1], P.lava[2], 14, 30);
  const r = rng(3);
  for (let i = 0; i < 10; i++) { const x = (r() * 28) | 0, y = 4 + (r() * 24) | 0; rect(im, x, y, 3, 2, P.lava[2]); px(im, x + 1, y - 1, [255, 255, 200, 255]); }
  rect(im, 0, 0, 32, 4, mix(P.lava[1], [0, 0, 0, 255], .25)); // crust
  return im;
})());

// gold: nuggets + sparkles
save(TILES, 'gold', (() => {
  const im = block(P.gold[0], P.gold[1], P.gold[2], 15, 40);
  const r = rng(6);
  for (let i = 0; i < 7; i++) { const x = (r() * 26) | 0, y = (r() * 26) | 0; rect(im, x, y, 4, 3, P.gold[2]); rect(im, x, y + 3, 4, 1, P.gold[1]); px(im, x + 1, y, [255, 255, 255, 255]); }
  return im;
})());

// ---------------- white door (the spawn point) ----------------
save(TILES, 'door', (() => {
  const im = img(32, 32);
  const frame = hx('#2aa18a'), frameD = hx('#1d7a67'), white = hx('#f6f7f5'), shade = hx('#d7dad6'), knob = hx('#f2c531');
  rect(im, 2, 1, 28, 31, frame);             // teal frame
  rect(im, 2, 1, 28, 2, mix(frame, [255, 255, 255, 255], .3));
  rect(im, 3, 31, 26, 1, frameD);
  rect(im, 5, 4, 22, 27, white);             // white panel
  for (let y = 4; y < 31; y++) px(im, 5, y, shade);
  rect(im, 5, 4, 22, 1, hx('#ffffff'));
  rect(im, 8, 8, 16, 1, shade); rect(im, 8, 20, 16, 1, shade); // panel lines
  rect(im, 9, 9, 14, 10, mix(white, shade, .35));
  rect(im, 24, 16, 2, 3, knob);              // knob
  return im;
})());

// ---------------- locks ----------------
function lock(plateHex, seed) {
  const plate = hx(plateHex);
  const im = block(plate, mix(plate, [0, 0, 0, 255], .35), mix(plate, [255, 255, 255, 255], .35), seed, 30);
  const body = mix(plate, [0, 0, 0, 255], .45), face = mix(plate, [255, 255, 255, 255], .25), key = mix(plate, [0, 0, 0, 255], .65);
  rect(im, 10, 15, 12, 11, body);            // padlock body
  rect(im, 11, 16, 10, 9, face);
  for (let x = 12; x <= 20; x++) { px(im, x, 10, body); }   // shackle top
  rect(im, 12, 10, 1, 6, body); rect(im, 19, 10, 1, 6, body); // shackle sides
  rect(im, 15, 18, 2, 3, key); px(im, 15, 21, key); px(im, 17, 21, key); // keyhole
  return im;
}
save(TILES, 'world_lock', lock('#3a7bd5', 21));
save(TILES, 'small_lock', lock('#d59f3a', 22));
save(TILES, 'huge_lock', lock('#9b3ad5', 23));

// ---------------- gem (blue, faceted) ----------------
save(ITEMS, 'gem', (() => {
  const im = img(16, 16);
  const base = hx('#37c6e0'), dark = hx('#1c84a6'), light = hx('#b8f1ff'), edge = hx('#0d5e78');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.abs(x - 8) + Math.abs(y - 8);
    if (d < 6) px(im, x, y, x + y < 16 ? (x < 8 ? light : base) : dark);
    else if (d < 7) px(im, x, y, edge);
  }
  rect(im, 5, 4, 2, 1, [255, 255, 255, 255]); px(im, 8, 4, [255, 255, 255, 255]);
  return im;
})());

// ---------------- seed (sprout) ----------------
save(ITEMS, 'seed', (() => {
  const im = img(16, 16);
  const seedC = hx('#8a5a2b'), seedD = hx('#5c3717'), stem = hx('#3f9136'), leaf = hx('#5cb350');
  rect(im, 6, 10, 4, 4, seedC); rect(im, 6, 13, 4, 1, seedD); px(im, 7, 10, hx('#a06a34'));
  rect(im, 8, 5, 1, 6, stem);
  rect(im, 5, 6, 3, 2, leaf); rect(im, 9, 4, 3, 2, leaf); px(im, 6, 5, stem); px(im, 11, 3, stem);
  return im;
})());

// ---------------- player (20x28, faces right) ----------------
const SK = hx('#f4cda0'), SKD = hx('#d9aa78'), HAIR = hx('#5a3a1b'), SHIRT = hx('#3a7bd5'), SHIRTD = hx('#2b5fa6'), PANT = hx('#39414f'), SHOE = hx('#23262e'), EYE = hx('#ffffff'), PUP = hx('#202020');
// Paint the character body onto an existing image at absolute coords.
// The body is always centred on column x=10 (the renderer anchors there), so a
// wider canvas just adds room on the right for the punching arm.
function paintBody(im, pose, phase = 0, opts = {}) {
  // hair + head
  rect(im, 4, 1, 12, 4, HAIR);
  rect(im, 4, 4, 12, 8, SK);
  rect(im, 4, 11, 12, 1, SKD);
  // eyes (big, looking right)
  rect(im, 7, 6, 3, 4, EYE); rect(im, 11, 6, 3, 4, EYE);
  if (pose === 'hurt') { px(im, 7, 6, PUP); px(im, 9, 8, PUP); px(im, 11, 6, PUP); px(im, 13, 8, PUP); px(im, 9, 6, PUP); px(im, 7, 8, PUP); px(im, 13, 6, PUP); px(im, 11, 8, PUP); }
  else { rect(im, 9, 7, 1, 2, PUP); rect(im, 13, 7, 1, 2, PUP); }
  rect(im, 8, 10, 4, 1, SKD); // mouth
  // body / shirt
  rect(im, 4, 12, 12, 9, SHIRT);
  rect(im, 4, 19, 12, 2, SHIRTD);
  rect(im, 4, 12, 12, 1, mix(SHIRT, [255, 255, 255, 255], .25));
  // arms
  rect(im, 2, 12, 2, 7, SK);                         // left arm
  if (!opts.noRightArm) rect(im, 16, 12, 2, 7, SK);  // right arm (omitted while punching)
  // legs / shoes by pose
  if (pose === 'jump') {
    rect(im, 5, 20, 4, 4, PANT); rect(im, 11, 20, 4, 4, PANT);
    rect(im, 5, 23, 4, 1, SHOE); rect(im, 11, 23, 4, 1, SHOE);
    rect(im, 1, 11, 2, 4, SK); rect(im, 17, 11, 2, 4, SK); // arms slightly up
  } else {
    const lx = 6 + phase, rx = 11 - phase;
    rect(im, lx, 21, 3, 6, PANT); rect(im, rx, 21, 3, 6, PANT);
    rect(im, lx, 27, 3, 1, SHOE); rect(im, rx, 27, 3, 1, SHOE);
  }
}
function drawPlayer(pose, phase = 0) { const im = img(20, 28); paintBody(im, pose, phase); return im; }

// Body used while punching. The punching arm is drawn + rotated at runtime
// (so it can aim anywhere), so this frame omits the right arm.
function drawPunchBody() { const im = img(20, 28); paintBody(im, 'stand', 0, { noRightArm: true }); return im; }

save(PLAYER, 'stand', drawPlayer('stand', 0));
save(PLAYER, 'jump', drawPlayer('jump'));
save(PLAYER, 'hurt', drawPlayer('hurt', 0));
save(PLAYER, 'punchbody', drawPunchBody());
for (let i = 0; i < 11; i++) {
  const phase = Math.round(Math.sin((i / 11) * Math.PI * 2) * 2);
  save(PLAYER, 'walk' + String(i + 1).padStart(2, '0'), drawPlayer('walk', phase));
}

console.log('Generated original Growtopia-style pixel sprites:');
console.log('  tiles  :', fs.readdirSync(TILES).filter((f) => f.endsWith('.png')).length, 'png');
console.log('  items  :', fs.readdirSync(ITEMS).filter((f) => f.endsWith('.png')).length, 'png');
console.log('  player :', fs.readdirSync(PLAYER).filter((f) => f.endsWith('.png')).length, 'png');
