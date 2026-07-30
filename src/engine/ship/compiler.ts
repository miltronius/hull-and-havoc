/**
 * The ship compiler: turns an editable design `Map` into a simulated ship.
 *
 * **This module is pure physics — it must never import Three.js.** That is
 * what lets `tests/physics.test.ts` compile a real ship and step it in Node,
 * which in turn is what lets us pin the behaviours that were originally found
 * the hard way: the depth-hold settling time, the phantom yaw on submerged
 * hulls, the trim axis bleeding into heading.
 *
 * The visual half lives in `ship/view.ts` and pairs up by iterating
 * `ship.blocks` in the same order this file builds it.
 */

import * as CANNON from 'cannon';

import {
  ANGULAR_DAMP,
  B,
  BLOCKS,
  G,
  HB,
  LINEAR_DAMP,
  RELOAD_SURFACE,
  TORP_RELOAD,
  FLOOD_LIFT_LOSS,
} from '../constants';
import type { Design, Ship, ShipBlock, Spawn } from '../types';
import { designStats, parseKey } from './design';

/**
 * Compile a design into a compound rigid body plus per-block bookkeeping.
 *
 * The compound is recentred on the mass-weighted centroid, so the body's
 * origin is its actual centre of mass. Everything downstream — thrust,
 * drag, damage impulses — depends on that being true.
 */
export function buildShip(
  world: CANNON.World,
  design: Design,
  spawn: Spawn,
  isPlayer: boolean,
): Ship {
  const stats = designStats(design);

  // Mass-weighted centroid, in world units.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  design.forEach((type, k) => {
    const [ix, iy, iz] = parseKey(k);
    const m = BLOCKS[type].mass;
    cx += ix * B * m;
    cy += (iy * B + HB) * m;
    cz += iz * B * m;
  });
  if (stats.mass > 0) {
    cx /= stats.mass;
    cy /= stats.mass;
    cz /= stats.mass;
  }

  const body = new CANNON.Body({
    mass: stats.mass,
    linearDamping: LINEAR_DAMP,
    angularDamping: ANGULAR_DAMP,
  });
  body.position.set(spawn.x, 1.2, spawn.z);
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), spawn.heading);

  const blocks: ShipBlock[] = [];
  design.forEach((type, k) => {
    const [ix, iy, iz] = parseKey(k);
    const lx = ix * B - cx;
    const ly = iy * B + HB - cy;
    const lz = iz * B - cz;
    const def = BLOCKS[type];

    const shape = new CANNON.Box(new CANNON.Vec3(HB, HB, HB));
    body.addShape(shape, new CANNON.Vec3(lx, ly, lz));

    blocks.push({
      type,
      shape,
      alive: true,
      hp: def.hp,
      maxHp: def.hp,
      mass: def.mass,
      lift: def.lift,
      local: new CANNON.Vec3(lx, ly, lz),
      // Two buoyancy sample points per block, one low and one high. Lift is
      // applied at each of these, which is what rights a listing hull.
      s1: new CANNON.Vec3(lx, ly - HB * 0.5, lz),
      s2: new CANNON.Vec3(lx, ly + HB * 0.3, lz),
      isCannon: type === 'cannon',
      isLight: type === 'light',
      isTorpedo: type === 'torpedo',
    });
  });

  world.addBody(body);

  const ship: Ship = {
    body,
    blocks,
    stats,
    isPlayer,
    alive: true,
    spawn,

    initialBlocks: blocks.length,
    initialMass: stats.mass,

    liveCount: blocks.length,
    liveLift: stats.lift,
    liveMass: stats.mass,
    engines: stats.engines,
    cannons: stats.cannons,
    torpedoes: stats.torps,
    lights: stats.lights,
    ballastTanks: stats.ballast,
    ballastCut: stats.ballastCut,
    buoyant: true,

    ballast: 0,
    buoyMul: 1,
    flooding: 0,
    tiltDeg: 0,
    capsizeAngle: stats.capsizeAngle,
    targetDepth: 0,
    autoDepth: true,
    trimCmd: { pitch: 0, roll: 0, auth: 0 },

    reload: 0,
    reloadMax: RELOAD_SURFACE,
    torpReload: 0,
    torpReloadMax: TORP_RELOAD,

    sinkTimer: 0,
    aimBias: 1,
    band: undefined,
    rangeTimer: 0,
  };

  recountShip(ship);
  return ship;
}

/**
 * Recompute live capabilities after blocks are lost.
 *
 * There is no hull-integrity number anywhere in this game. Losing blocks
 * directly reduces lift and mass, and `buoyant` falls out of the comparison.
 * Buoyancy *is* the health system.
 */
export function recountShip(ship: Ship): void {
  let engines = 0;
  let cannons = 0;
  let ballast = 0;
  let live = 0;
  let lift = 0;
  let mass = 0;
  let torps = 0;
  let lights = 0;

  for (const b of ship.blocks) {
    if (!b.alive) continue;
    live++;
    lift += b.lift;
    mass += b.mass;
    if (b.type === 'engine') engines++;
    if (b.type === 'cannon') cannons++;
    if (b.type === 'ballast') ballast++;
    if (b.type === 'torpedo') torps++;
    if (b.type === 'light') lights++;
  }

  ship.engines = engines;
  ship.cannons = cannons;
  ship.torpedoes = torps;
  ship.lights = lights;
  ship.liveCount = live;
  ship.liveLift = lift;
  ship.liveMass = mass;
  ship.ballastCut = Math.min(0.9, ballast * 0.25);
  ship.ballastTanks = ballast;
  // Could this hull float again with the tanks blown?
  ship.buoyant = mass > 0 && (lift * (1 - ship.flooding * FLOOD_LIFT_LOSS)) / (mass * G) > 1.0;
}

/** Where a destroyed block was, in world space, for debris and splash. */
export interface BlockRemoval {
  x: number;
  y: number;
  z: number;
}

/**
 * Detach a single block from the compound body.
 *
 * cannon 0.6.2 has no `removeShape()`, so the shape must be spliced out of
 * three parallel arrays by hand and the derived properties recomputed. Phase 2
 * can replace this with `body.removeShape(shape)` — but keep the explicit
 * `updateMassProperties()` / `updateBoundingRadius()` calls either way.
 *
 * Returns the block's last world position, or `null` if it was already dead.
 * Debris and splash are the caller's job; this module draws nothing.
 */
export function destroyBlock(ship: Ship, blk: ShipBlock): BlockRemoval | null {
  if (!blk.alive) return null;
  blk.alive = false;

  // World position before we detach it.
  const wp = new CANNON.Vec3();
  ship.body.quaternion.vmult(blk.local, wp);
  wp.vadd(ship.body.position, wp);

  const idx = ship.body.shapes.indexOf(blk.shape);
  if (idx >= 0) {
    ship.body.shapes.splice(idx, 1);
    ship.body.shapeOffsets.splice(idx, 1);
    ship.body.shapeOrientations.splice(idx, 1);
  }
  // Floor the mass: a zero-mass body would become static mid-battle.
  ship.body.mass = Math.max(40, ship.body.mass - blk.mass);
  ship.body.updateMassProperties();
  ship.body.updateBoundingRadius();
  ship.body.aabbNeedsUpdate = true;

  recountShip(ship);
  return { x: wp.x, y: wp.y, z: wp.z };
}

export function removeShip(world: CANNON.World, ship: Ship): void {
  world.remove(ship.body);
}
