import WebSocket from 'ws';
const URL = process.env.TEST_WS_URL || 'ws://localhost:3000';
const ok = (c, m) => console.log((c ? 'PASS' : 'FAIL') + ' ' + m);
// wait for an 'inventory' message satisfying pred, skipping stale ones in flight
async function waitInv(c, pred, tries = 8) {
  for (let i = 0; i < tries; i++) { const m = await c.wait('inventory'); if (pred(m)) return m; }
  return null;
}

function client() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      const i = waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) { waiters.splice(i, 1)[0].resolve(m); } else { inbox.push(m); }
    });
    const api = {
      send: (t, p = {}) => ws.send(JSON.stringify({ type: t, ...p })),
      wait: (t) => new Promise((res) => {
        const i = inbox.findIndex((m) => m.type === t);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        waiters.push({ type: t, resolve: res });
      }),
      flush: (t) => { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === t) inbox.splice(i, 1); },
    };
    ws.on('open', () => resolve(api));
    ws.on('error', (e) => console.log('WS ERROR', e.message));
  });
}

const fail = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);

try {
  const D = await client();
  D.send('login', { name: '@XtremeFire', password: 'devpass' });
  let w = await D.wait('welcome');
  ok(w.dev === true, 'dev flag on welcome');
  ok(w.gems >= 9e15, 'dev infinite gems (' + w.gems + ')');
  ok(!!w.inventory.basic_shirt && !!w.inventory.basic_pants, 'starts owning shirt + pants');
  ok(!w.equipped.shirt && !w.equipped.pants, 'spawns naked (nothing equipped)');

  D.send('enterWorld', { name: 'DEVWORLD' });
  await D.wait('worldData');
  D.send('equip', { itemId: 'basic_shirt' });
  let inv = await D.wait('inventory');
  ok(inv.equipped.shirt === 'basic_shirt', 'equip shirt -> shirt slot set');
  D.send('equip', { itemId: 'basic_pants' });
  inv = await D.wait('inventory');
  ok(inv.equipped.pants === 'basic_pants', 'pants go in their own slot');
  D.send('equip', { itemId: 'basic_shirt' });
  inv = await D.wait('inventory');
  ok(!inv.equipped.shirt && inv.equipped.pants === 'basic_pants', 'double-tap shirt unequips only the shirt');

  const N = await client();
  N.send('register', { name: 'Bob', password: 'bobpass' });
  const bw = await N.wait('welcome');
  ok(bw.dev === false, 'Bob not a dev initially');
  D.send('setDeveloper', { name: 'Bob', grant: true });
  const bs = await N.wait('devStatus');
  ok(bs.dev === true, 'Bob gets devStatus dev=true after grant');
  const bgem = await N.wait('inventory');
  ok(bgem.gems >= 9e15, 'Bob now shows infinite gems');
  D.send('setDeveloper', { name: 'Bob', grant: false });
  const bs2 = await N.wait('devStatus');
  ok(bs2.dev === false, 'Bob dev removed');
  const bgem2 = await N.wait('inventory');
  ok(bgem2.gems < 9e15, 'Bob gems revert to real value (' + bgem2.gems + ')');

  // guest accounts: each guest is its own persistent random account + token
  const G1 = await client();
  G1.send('join', {});
  const g1 = await G1.wait('welcome');
  ok(/^Guest/i.test(g1.name) && !!g1.guestToken, 'new guest gets a random name + token');
  const gName = g1.name, gToken = g1.guestToken;
  const G2 = await client();
  G2.send('join', {});
  const g2 = await G2.wait('welcome');
  ok(g2.name !== g1.name, 'a second guest gets a different account');
  const G3 = await client();
  G3.send('join', { guestName: gName, guestToken: gToken });
  const r3 = await Promise.race([G3.wait('welcome'), G3.wait('authError')]);
  ok(r3.text === 'That account is already logged in.', 'valid token resolves to the same (still-online) guest account');
  const G4 = await client();
  G4.send('join', { guestName: gName, guestToken: 'wrongtoken' });
  const g4 = await G4.wait('welcome');
  ok(g4.name !== gName, 'a bad guest token mints a fresh account instead');

  // world-lock: only one allowed per world (use the dev account for gems)
  D.send('buy', { itemId: 'world_lock', qty: 2 }); await D.wait('inventory');
  D.send('enterWorld', { name: 'SOLOWORLD' });
  const ow = await D.wait('worldData');
  const sx = ow.world.spawn.tx, sy = ow.world.spawn.ty;
  D.send('place', { x: sx - 2, y: sy - 1, itemId: 'world_lock' });
  const t1 = await D.wait('tileUpdate');
  ok(t1.fg === 'world_lock', 'first world lock places');
  await new Promise((res) => setTimeout(res, 150)); // let any trailing notifies arrive
  D.flush('notify');                                 // clear older buffered notifications
  D.send('place', { x: sx + 2, y: sy - 1, itemId: 'world_lock' });
  const r = await D.wait('notify');
  ok(/already has a World Lock/i.test(r.text || ''), 'second world lock refused: "' + r.text + '"');
  // locks now take 12 hits to break — one hit should NOT remove it
  D.send('break', { x: sx - 2, y: sy - 1 });
  const bp = await D.wait('breakProgress');
  ok(bp.hits === 1 && bp.hardness === 12, 'lock break is gradual (1/12 after one hit)');
  for (let k = 0; k < 11; k++) D.send('break', { x: sx - 2, y: sy - 1 });
  const t2 = await D.wait('tileUpdate');
  ok(t2.fg === '' && t2.x === sx - 2, 'lock removed after 12 hits');

  // item packs grant a bundle
  D.flush('notify'); D.flush('inventory');
  D.send('buyPack', { packId: 'pack_seeds' });
  const pinv = await waitInv(D, (m) => m.inventory.grass_seed >= 2);
  ok(pinv && pinv.inventory.dirt_seed >= 2, 'buying a pack grants the bundle');

  // Angel Wings are equippable in the wings slot
  D.send('buy', { itemId: 'wings', qty: 1 });
  await waitInv(D, (m) => m.inventory.wings >= 1);
  D.send('equip', { itemId: 'wings' });
  const winv = await waitInv(D, (m) => m.equipped && m.equipped.wings === 'wings');
  ok(!!winv, 'Angel Wings equip into the wings slot');

  // --- moderation commands (D is a developer, in SOLOWORLD) ---
  const V = await client();
  V.send('register', { name: 'Victim', password: 'vpass' });
  await V.wait('welcome');
  V.send('enterWorld', { name: 'SOLOWORLD' }); await V.wait('worldData');
  D.send('command', { cmd: 'kick', arg: 'Victim' });
  ok(!!(await V.wait('respawnAt')), 'kick sends the victim to spawn');
  D.send('command', { cmd: 'worldban', arg: 'Victim' });
  const kicked = await V.wait('kickedFromWorld');
  ok(/banned/i.test(kicked.reason || ''), 'worldban removes the victim from the world');
  D.send('command', { cmd: 'gameban', arg: 'Victim' });
  ok(!!(await V.wait('gameBanned')), 'gameban notifies the victim');
  const V2 = await client();
  V2.send('login', { name: 'Victim', password: 'vpass' });
  const ae = await V2.wait('authError');
  ok(/banned/i.test(ae.text || ''), 'game-banned account cannot log in');
  D.flush('notify');
  D.send('command', { cmd: 'gameban', arg: '@XtremeFire' });
  const imm = await D.wait('notify');
  ok(/cannot ban a developer/i.test(imm.text || ''), 'developers are immune to bans');

  clearTimeout(fail);
  process.exit(0);
} catch (e) {
  console.log('ERROR', e.message);
  process.exit(1);
}
