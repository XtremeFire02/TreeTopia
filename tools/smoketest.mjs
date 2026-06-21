// End-to-end protocol smoke test against a running server.
import WebSocket from 'ws';

const URL = process.env.TEST_WS_URL || 'ws://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? '  PASS ' : '  FAIL ') + m); };

function mkClient() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === msg.type) { waiters[i].resolve(msg); waiters.splice(i, 1); }
    }
  });
  const api = {
    ws,
    send: (type, p = {}) => ws.send(JSON.stringify({ type, ...p })),
    wait: (type, ms = 1500) => new Promise((resolve, reject) => {
      const found = inbox.find((m) => m.type === type);
      if (found) return resolve(found);
      const w = { type, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timeout waiting for ' + type)), ms);
    }),
    open: () => new Promise((r) => ws.on('open', r)),
    clear: () => { inbox.length = 0; },
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RID = Math.random().toString(36).slice(2, 7);

(async () => {
  const a = mkClient();
  await a.open();

  // --- register a named account (guests now get random names, so use register
  //     when a stable name is needed) => fresh starter profile each run ---
  a.send('register', { name: 'Tester' + RID, password: 'testpass' });
  const welcome = await a.wait('welcome');
  ok(welcome.gems === 100, `welcome gems=100 (got ${welcome.gems})`);
  ok(welcome.inventory.dirt === 10, `starter dirt=10 (got ${welcome.inventory.dirt})`);
  ok(welcome.inventory.small_lock === 1, 'starter small_lock=1');
  ok(welcome.inventory.fist === 1 && welcome.inventory.wrench === 1, 'permanent tools granted (fist + wrench)');

  await a.wait('worldList');

  // --- enter world ---
  a.send('enterWorld', { name: 'SMOKE' + RID });
  const wd = await a.wait('worldData');
  const W = wd.world;
  ok(W.fg.includes('door'), 'world has a white door');
  ok(W.fg.filter((t) => t === 'bedrock').length >= W.width, 'world has a bedrock floor');
  ok(W.spawn && typeof W.spawn.tx === 'number', 'world has a spawn point');
  const groundRow = W.fg.findIndex((t) => t === 'grass') >= 0;
  ok(groundRow, 'world has a grass surface');
  const sx = W.spawn.tx, sy = W.spawn.ty;

  // send a move so the server registers our position near spawn (for reach)
  a.send('move', { x: sx * 32 + 16, y: sy * 32 + 32, vx: 0, vy: 0, dir: 1, anim: 'idle', name: 'Tester' });
  await sleep(50);

  // --- place a dirt block on an empty sky tile beside the door
  //     (offset sideways so it isn't on top of the player) ---
  const px = sx + 2, py = sy - 1;
  a.clear();
  a.send('place', { x: px, y: py, itemId: 'dirt', layer: 0 });
  const tu = await a.wait('tileUpdate');
  ok(tu.x === px && tu.y === py && tu.fg === 'dirt', 'placed dirt appears');
  const inv1 = await a.wait('inventory');
  ok(inv1.inventory.dirt === 9, `dirt decremented to 9 (got ${inv1.inventory.dirt})`);

  // --- break it (hardness 4): first tileUpdate on this tile is its removal ---
  a.clear();
  const removal = a.wait('tileUpdate', 4000).catch(() => null);
  for (let i = 0; i < 6; i++) { a.send('break', { x: px, y: py }); await sleep(80); }
  const r = await removal;
  ok(r && r.x === px && r.y === py && r.fg === '', 'dirt block breaks after enough hits');

  // --- buy a grass seed, then splice with a dirt seed -> sand seed ---
  a.send('buy', { itemId: 'grass_seed', qty: 1 });
  await a.wait('inventory');
  a.clear();
  a.send('splice', { a: 'dirt_seed', b: 'grass_seed' });
  const invSplice = await a.wait('inventory');
  ok(invSplice.inventory.sand_seed === 1, 'splice dirt+grass = sand seed');

  // --- plant a seed -> tree ---
  a.clear();
  a.send('place', { x: sx + 1, y: sy - 1, itemId: 'dirt_seed', layer: 0 });
  const plantTU = await a.wait('tileUpdate');
  ok(plantTU.fg === '__tree__', 'planting a seed grows a tree');

  // --- place a small lock and confirm ownership/permission ---
  a.clear();
  a.send('place', { x: sx - 2, y: sy - 1, itemId: 'small_lock', layer: 0 });
  const lockTU = await a.wait('tileUpdate');
  ok(lockTU.fg === 'small_lock' && lockTU.data && lockTU.data.lock, 'small lock places with lock data');

  // --- second player cannot build inside the locked area ---
  const b = mkClient();
  await b.open();
  b.send('register', { name: 'Intruder' + RID, password: 'testpass' });
  const bWelcome = await b.wait('welcome');
  await b.wait('worldList');
  b.send('enterWorld', { name: 'SMOKE' + RID });
  await b.wait('worldData');
  b.send('move', { x: (sx - 2) * 32 + 16, y: sy * 32 + 32, vx: 0, vy: 0, dir: 1, anim: 'idle', name: 'Intruder' });
  await sleep(50);
  b.clear();
  b.send('place', { x: sx - 2, y: sy - 2, itemId: 'dirt', layer: 0 });
  const notify = await b.wait('notify').catch(() => null);
  ok(notify && /lock/i.test(notify.text), 'intruder is blocked by the lock');

  // --- trading: normal item stacks can be offered (regression for offer clamp) ---
  a.clear(); b.clear();
  a.send('tradeRequest', { targetId: bWelcome.id });
  const req = await b.wait('tradeRequest').catch(() => null);
  ok(req && req.fromId === welcome.id, 'trade request reaches the target player');
  b.send('tradeAccept', { fromId: welcome.id });
  await a.wait('tradeWindow');
  await b.wait('tradeWindow');
  a.clear(); b.clear();
  a.send('tradeOffer', { items: { dirt: 1 }, gems: 0 });
  const tradeA = await a.wait('tradeWindow').catch(() => null);
  const tradeB = await b.wait('tradeWindow').catch(() => null);
  ok(tradeA && tradeA.yourItems.dirt === 1 && tradeB && tradeB.theirItems.dirt === 1, 'trade offer accepts a normal dirt stack');
  a.send('tradeCancel');
  await a.wait('tradeDone').catch(() => null);
  await b.wait('tradeDone').catch(() => null);

  // --- main door cannot be broken (when standing beside it, not on it) ---
  a.clear();
  a.send('move', { x: (sx + 2) * 32 + 16, y: sy * 32 + 32, vx: 0, vy: 0, dir: 1, anim: 'idle', name: 'Tester' });
  await sleep(60);
  a.send('break', { x: sx, y: sy });
  const doorNotify = await a.wait('notify').catch(() => null);
  ok(doorNotify && /door/i.test(doorNotify.text), 'main door cannot be broken from beside it');

  // --- standing ON the door and punching exits the world ---
  a.clear();
  a.send('move', { x: sx * 32 + 16, y: sy * 32 + 32, vx: 0, vy: 0, dir: 1, anim: 'idle', name: 'Tester' });
  await sleep(60);
  a.send('break', { x: sx, y: sy });
  const exited = await a.wait('kickedFromWorld').catch(() => null);
  ok(!!exited, 'punching the door while standing on it exits the world');

  // --- accounts: register + login with password ---
  const uname = 'Acc' + RID, pw = 'pw' + RID;
  const accc = mkClient(); await accc.open();
  accc.send('register', { name: uname, password: pw });
  const accW = await accc.wait('welcome').catch(() => null);
  ok(accW && accW.name === uname, 'register creates an account and logs in');
  accc.ws.close();

  const acc2 = mkClient(); await acc2.open();
  acc2.send('login', { name: uname, password: 'wrongpw' });
  const authErr = await acc2.wait('authError').catch(() => null);
  ok(authErr && /password/i.test(authErr.text), 'login rejects a wrong password');
  acc2.send('login', { name: uname, password: pw });
  const accW2 = await acc2.wait('welcome').catch(() => null);
  ok(accW2 && accW2.name === uname, 'login accepts the correct password');
  acc2.ws.close();

  // --- account names are unique case-insensitively, but preserve display casing ---
  const caseName = 'Case' + RID;
  const case1 = mkClient(); await case1.open();
  case1.send('register', { name: caseName, password: 'casepass' });
  const caseW = await case1.wait('welcome').catch(() => null);
  ok(caseW && caseW.name === caseName, 'register preserves account name casing');
  const case2 = mkClient(); await case2.open();
  case2.send('register', { name: caseName.toLowerCase(), password: 'casepass' });
  const caseTaken = await case2.wait('authError').catch(() => null);
  ok(caseTaken && /taken/i.test(caseTaken.text), 'duplicate account casing is rejected');
  case1.ws.close(); case2.ws.close();
  await sleep(100);
  const case3 = mkClient(); await case3.open();
  case3.send('login', { name: caseName.toLowerCase(), password: 'casepass' });
  const caseLogin = await case3.wait('welcome').catch(() => null);
  ok(caseLogin && caseLogin.name === caseName, 'login resolves account casing case-insensitively');
  case3.ws.close();

  // --- profile / achievements (Tester broke a block and spliced) ---
  a.clear();
  a.send('getProfile', { name: 'Tester' + RID });
  const prof = await a.wait('profile').catch(() => null);
  ok(prof && prof.name === 'Tester' + RID, 'getProfile returns the profile');
  ok(prof && prof.achievements.length >= 1, 'profile shows earned achievements');

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  a.ws.close(); b.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
