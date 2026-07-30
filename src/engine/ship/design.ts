/**
 * The design model: a `Map` from grid coordinate to block type, and the pure
 * functions that derive every stat from it.
 *
 * Nothing in this file touches Three.js or cannon. That is deliberate — the
 * shipyard's live ship report, the campaign's difficulty estimation, and the
 * unit tests all run the same code with no renderer and no physics world.
 */

import { BLOCKS, G, getStabilityUpgrade } from '../constants';
import type { Design, DesignKey, DesignStats, GridCoord } from '../types';

/** Build the map key for a grid coordinate. */
export function key(x: number, y: number, z: number): DesignKey {
  return `${x},${y},${z}`;
}

/**
 * Inverse of {@link key}. The prototype inlined `k.split(',').map(Number)` in
 * five places; centralising it here also gives us a properly typed tuple
 * instead of `(number | undefined)[]`.
 */
export function parseKey(k: DesignKey): GridCoord {
  const parts = k.split(',');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

// ─── Stock designs ───────────────────────────────────────────────────────

/** The boat you get on first load: floats, one gun, one tank, one engine. */
export function starterDesign(): Design {
  const d: Design = new Map();
  for (let x = -1; x <= 1; x++) {
    for (let z = -2; z <= 2; z++) d.set(key(x, 0, z), 'hull');
  }
  d.set(key(0, 1, -2), 'engine');
  d.set(key(0, 1, -1), 'ballast');
  d.set(key(0, 1, 0), 'hull');
  d.set(key(0, 1, 1), 'cannon');
  d.set(key(0, 1, 2), 'hull');
  return d;
}

/** Phase 4 replaces this with a roster in `game/campaign.ts`. */
export function enemyDesign(): Design {
  const d: Design = new Map();
  for (let x = -1; x <= 1; x++) {
    for (let z = -2; z <= 3; z++) d.set(key(x, 0, z), 'hull');
  }
  d.set(key(-1, 1, -2), 'engine');
  d.set(key(1, 1, -2), 'engine');
  d.set(key(0, 1, -1), 'hull');
  d.set(key(0, 1, 0), 'cannon');
  d.set(key(0, 1, 2), 'armor');
  d.set(key(0, 1, 3), 'armor');
  return d;
}

// ─── Connectivity ────────────────────────────────────────────────────────

const NEIGHBORS: readonly GridCoord[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

export interface Connectivity {
  ok: boolean;
  set: Set<DesignKey>;
  orphans: number;
}

/**
 * Flood fill from an arbitrary block: every block must touch the main
 * structure face-to-face. Diagonal contact does not count — you cannot sail
 * a ship held together at the corners.
 */
export function connectivity(design: Design): Connectivity {
  const all = [...design.keys()];
  const first = all[0];
  if (first === undefined) return { ok: true, set: new Set(), orphans: 0 };

  const seen = new Set<DesignKey>([first]);
  const stack: DesignKey[] = [first];
  while (stack.length) {
    const current = stack.pop();
    if (current === undefined) break;
    const [x, y, z] = parseKey(current);
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nk = key(x + dx, y + dy, z + dz);
      if (design.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        stack.push(nk);
      }
    }
  }
  return { ok: seen.size === all.length, set: seen, orphans: all.length - seen.size };
}

// ─── Stats ───────────────────────────────────────────────────────────────

/**
 * Derives everything the game knows about a design from the map alone.
 *
 * The two centroids are the heart of it: mass wants to pull one way, lift the
 * other, and the horizontal offset between them is what makes a ship list.
 * Lift-weighted beam (`spreadX`) sets how much heel the hull tolerates before
 * water starts coming in — a wide hull is a forgiving one.
 */
export function designStats(design: Design): DesignStats {
  let mass = 0;
  let lift = 0;
  let engines = 0;
  let cannons = 0;
  let ballast = 0;
  let count = 0;
  let torps = 0;
  let lights = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  let lx = 0;
  let lz = 0;

  design.forEach((type, k) => {
    const def = BLOCKS[type];
    const [ix, iy, iz] = parseKey(k);
    mass += def.mass;
    lift += def.lift;
    count++;
    mx += ix * def.mass;
    my += (iy + 0.5) * def.mass;
    mz += iz * def.mass;
    lx += ix * def.lift;
    lz += iz * def.lift;
    if (type === 'engine') engines++;
    if (type === 'cannon') cannons++;
    if (type === 'ballast') ballast++;
    if (type === 'torpedo') torps++;
    if (type === 'light') lights++;
  });

  const massCx = mass ? mx / mass : 0;
  const massCy = mass ? my / mass : 0;
  const massCz = mass ? mz / mass : 0;
  const liftCx = lift ? lx / lift : 0;
  const liftCz = lift ? lz / lift : 0;

  // Lift-weighted spread: how wide the buoyant base is, i.e. capsize resistance.
  let sx = 0;
  let sz = 0;
  design.forEach((type, k) => {
    const def = BLOCKS[type];
    const [ix, , iz] = parseKey(k);
    sx += def.lift * (ix - liftCx) * (ix - liftCx);
    sz += def.lift * (iz - liftCz) * (iz - liftCz);
  });
  const spreadX = lift ? Math.sqrt(sx / lift) : 0;
  const spreadZ = lift ? Math.sqrt(sz / lift) : 0;

  const offX = massCx - liftCx; // + = heavy to starboard
  const offZ = massCz - liftCz; // + = heavy toward the bow
  const capsizeRisk = massCy / (spreadX + 0.5); // tall + narrow = risky

  const liftRatio = mass > 0 ? lift / (mass * G) : 0;
  const ballastCut = Math.min(0.9, ballast * 0.25);
  const conn = connectivity(design);

  // Wider hulls tolerate more heel before water pours in.
  const capsizeAngle = Math.min(70, 26 + spreadX * 15 + getStabilityUpgrade());

  return {
    mass,
    lift,
    engines,
    cannons,
    ballast,
    count,
    torps,
    lights,
    liftRatio,
    ballastCut,
    offX,
    offZ,
    capsizeRisk,
    spreadX,
    spreadZ,
    capsizeAngle,
    connected: conn.ok,
    connectedSet: conn.set,
    orphans: conn.orphans,
    floats: liftRatio > 1.05,
    canDive: ballastCut > 0 && liftRatio * (1 - ballastCut) < 0.95,
  };
}
