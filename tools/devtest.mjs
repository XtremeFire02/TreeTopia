import WebSocket from 'ws';
const URL = 'ws://localhost:3000';
const ok = (c, m) => console.log((c ? 'PASS' : 'FAIL') + ' ' + m);

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
  // a developer can break/remove a lock (here, their own world lock)
  D.send('break', { x: sx - 2, y: sy - 1 });
  const t2 = await D.wait('tileUpdate');
  ok(t2.fg === '' && t2.x === sx - 2, 'developer removes the world lock');

  clearTimeout(fail);
  process.exit(0);
} catch (e) {
  console.log('ERROR', e.message);
  process.exit(1);
}
