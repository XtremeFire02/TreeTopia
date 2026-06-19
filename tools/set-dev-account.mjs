import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const DEV_NAME = '@XtremeFire';
const DEV_GEMS = Number.MAX_SAFE_INTEGER;
const STARTER_INVENTORY = { dirt: 10, dirt_seed: 3, small_lock: 1, fist: 1, wrench: 1 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'server', 'data');
const WORLDS_DIR = path.join(DATA, 'worlds');
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');
const PROFILES_FILE = path.join(DATA, 'profiles.json');

const password = process.argv[2];
if (!password || password.length < 4) {
  console.error('Usage: DATA_DIR=/var/lib/treetopia node tools/set-dev-account.mjs "new-password"');
  console.error('Password must be at least 4 characters.');
  process.exit(1);
}

fs.mkdirSync(WORLDS_DIR, { recursive: true });

const accounts = readJson(ACCOUNTS_FILE, {});
const profiles = readJson(PROFILES_FILE, {});
const legacyNames = Object.keys({ ...accounts, ...profiles }).filter(isLegacyDevName);
const sourceProfiles = [profiles[DEV_NAME], ...legacyNames.map((name) => profiles[name])].filter(Boolean);

accounts[DEV_NAME] = hashPw(password);
for (const name of legacyNames) delete accounts[name];

profiles[DEV_NAME] = {
  gems: DEV_GEMS,
  inventory: {
    ...STARTER_INVENTORY,
    ...mergeInventories(sourceProfiles),
    fist: 1,
    wrench: 1,
  },
  achievements: mergeLists(sourceProfiles, 'achievements'),
  ownedWorlds: mergeLists(sourceProfiles, 'ownedWorlds'),
};
for (const name of legacyNames) delete profiles[name];

writeJson(ACCOUNTS_FILE, accounts);
writeJson(PROFILES_FILE, profiles);
const migratedWorlds = migrateWorldOwnership();

console.log(`Developer account ready: ${DEV_NAME}`);
console.log(`Data directory: ${DATA}`);
console.log(`Migrated legacy names: ${legacyNames.length ? legacyNames.join(', ') : 'none'}`);
console.log(`Updated worlds: ${migratedWorlds}`);

function isLegacyDevName(name) {
  return /^xtremefire$/i.test(String(name || ''));
}

function shouldBecomeDevName(name) {
  return name === DEV_NAME || isLegacyDevName(name);
}

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return { salt, hash };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

function replaceDevNames(list) {
  if (!Array.isArray(list)) return list;
  return [...new Set(list.map((name) => shouldBecomeDevName(name) ? DEV_NAME : name))];
}

function mergeInventories(profilesToMerge) {
  const merged = {};
  for (const profile of profilesToMerge) {
    for (const [itemId, count] of Object.entries(profile.inventory || {})) {
      merged[itemId] = Math.max(merged[itemId] || 0, Number(count) || 0);
    }
  }
  return merged;
}

function mergeLists(profilesToMerge, key) {
  return [...new Set(profilesToMerge.flatMap((profile) => profile[key] || []))];
}

function migrateWorldOwnership() {
  if (!fs.existsSync(WORLDS_DIR)) return 0;

  let updated = 0;
  for (const entry of fs.readdirSync(WORLDS_DIR)) {
    if (!entry.endsWith('.json')) continue;

    const file = path.join(WORLDS_DIR, entry);
    const world = readJson(file, null);
    if (!world) continue;

    let changed = false;
    if (shouldBecomeDevName(world.owner)) {
      world.owner = DEV_NAME;
      changed = true;
    }
    const admins = replaceDevNames(world.admins);
    if (JSON.stringify(admins) !== JSON.stringify(world.admins)) {
      world.admins = admins;
      changed = true;
    }

    for (const tile of Object.values(world.data || {})) {
      if (!tile?.lock) continue;
      if (shouldBecomeDevName(tile.lock.owner)) {
        tile.lock.owner = DEV_NAME;
        changed = true;
      }
      const lockAdmins = replaceDevNames(tile.lock.admins);
      if (JSON.stringify(lockAdmins) !== JSON.stringify(tile.lock.admins)) {
        tile.lock.admins = lockAdmins;
        changed = true;
      }
    }

    if (changed) {
      writeJson(file, world);
      updated++;
    }
  }
  return updated;
}
