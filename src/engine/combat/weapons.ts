/**
 * Guns, torpedoes and damage.
 *
 * Pure simulation: projectile state is plain data, and everything visible goes
 * through the {@link Effects} seam. The view layer syncs meshes by walking
 * `combat.shells` / `combat.torpedoes` each frame.
 *
 * Damage is deliberately local. There is no ship-level HP bar — a hit finds
 * the nearest live block, damages it and its neighbours, and anything at zero
 * is spliced out of the compound body. Losing blocks costs lift and mass
 * directly, so "sinking" is emergent rather than scripted.
 */

import * as CANNON from 'cannon-es';

import {
  B,
  BLOCKS,
  CANNON_MAX_DEPTH,
  RELOAD_SURFACE,
  SEABED,
  SPLASH_DAMAGE,
  SPLASH_RADIUS,
  TORP_LIFE,
  TORP_MIN_DEPTH,
  TORP_RELOAD,
  TORP_SPEED,
  WATER_LEVEL,
  G,
  SHELL_DAMAGE,
  TORP_DAMAGE,
} from '../constants';
import type { Ship, ShipBlock, ShotSpotting } from '../types';
import { waveHeight, type WaveField } from '../waves';
import { destroyBlock } from '../ship/compiler';
import { shipDepth } from '../ship/buoyancy';
import { gunSolution, type Point3 } from './ballistics';
import { nullEffects, type Effects } from './effects';
import { spotCorrection } from './spotting';

// ─── Projectile state ────────────────────────────────────────────────────

export interface Shell {
  pos: Point3;
  prev: Point3;
  vel: Point3;
  life: number;
  /** Has it broken the surface yet? Drives the splash and the spotting call. */
  wet: boolean;
  owner: Ship;
  spot: ShotSpotting | null;
}

export interface Torpedo {
  pos: Point3;
  prev: Point3;
  /** Unit heading, flat in the XZ plane — torpedoes run level. */
  dir: Point3;
  /** Launch depth, held for the whole run. */
  depth: number;
  life: number;
  owner: Ship;
}

export interface Combat {
  shells: Shell[];
  torpedoes: Torpedo[];
}

export function createCombat(): Combat {
  return { shells: [], torpedoes: [] };
}

// ─── Firing ──────────────────────────────────────────────────────────────

export interface FireOptions {
  speed: number;
  elev: number;
  trav?: number;
  spot?: ShotSpotting | null;
  effects?: Effects;
}

/** Recoil impulse per gun in the salvo. */
const RECOIL_PER_GUN = -150;

/**
 * Fire every live gun on the ship.
 *
 * Returns false if the shot was refused — reloading, no guns left, or too deep.
 * Guns only work at or near the surface; that is what forces a submarine to
 * come up to use them.
 */
export function fire(ship: Ship, combat: Combat, opts: FireOptions): boolean {
  if (!ship.alive || ship.reload > 0 || shipDepth(ship) > CANNON_MAX_DEPTH) return false;

  const guns = ship.blocks.filter((b) => b.alive && b.isCannon);
  if (guns.length === 0) return false;

  const fx = opts.effects ?? nullEffects;
  const trav = opts.trav ?? 0;
  ship.reload = RELOAD_SURFACE;
  ship.reloadMax = RELOAD_SURFACE;

  let lastDir: CANNON.Vec3 | null = null;
  for (const g of guns) {
    const sol = gunSolution(ship, g, opts.elev, trav);
    lastDir = sol.dir;
    combat.shells.push({
      pos: { x: sol.pos.x, y: sol.pos.y, z: sol.pos.z },
      prev: { x: sol.pos.x, y: sol.pos.y, z: sol.pos.z },
      vel: {
        x: sol.dir.x * opts.speed,
        y: sol.dir.y * opts.speed,
        z: sol.dir.z * opts.speed,
      },
      life: 6,
      wet: false,
      owner: ship,
      spot: opts.spot ?? null,
    });
    fx.splash(sol.pos.x, sol.pos.y, sol.pos.z, 0xffd27f, 6, 0.4);
  }

  if (lastDir) {
    const rec = RECOIL_PER_GUN * guns.length;
    // No relative point — cannon-es defaults it to the centre of mass, so
    // recoil pushes the hull without spinning it.
    ship.body.applyImpulse(new CANNON.Vec3(lastDir.x * rec, lastDir.y * rec, lastDir.z * rec));
  }
  return true;
}

const _fwd = new CANNON.Vec3();
const _localZ = new CANNON.Vec3(0, 0, 1);
const _tubeLocal = new CANNON.Vec3();
const _tubeWorld = new CANNON.Vec3();

/**
 * Launch every live tube. Only works while properly submerged — the mirror of
 * the gun's surface restriction, and the reason a hull with both wants to
 * change depth mid-fight.
 */
export function fireTorpedo(ship: Ship, combat: Combat, effects: Effects = nullEffects): boolean {
  if (!ship.alive || ship.torpReload > 0) return false;
  if (shipDepth(ship) < TORP_MIN_DEPTH) return false;

  const tubes = ship.blocks.filter((b) => b.alive && b.isTorpedo);
  if (tubes.length === 0) return false;

  ship.torpReload = TORP_RELOAD;
  ship.torpReloadMax = TORP_RELOAD;

  // Torpedoes run flat: take the hull's heading and drop any pitch.
  ship.body.quaternion.vmult(_localZ, _fwd);
  const flatLen = Math.hypot(_fwd.x, _fwd.z) || 1;
  const dir: Point3 = { x: _fwd.x / flatLen, y: 0, z: _fwd.z / flatLen };

  for (const tube of tubes) {
    _tubeLocal.set(tube.local.x, tube.local.y - 0.1, tube.local.z + B);
    ship.body.quaternion.vmult(_tubeLocal, _tubeWorld);
    _tubeWorld.vadd(ship.body.position, _tubeWorld);

    combat.torpedoes.push({
      pos: { x: _tubeWorld.x, y: _tubeWorld.y, z: _tubeWorld.z },
      prev: { x: _tubeWorld.x, y: _tubeWorld.y, z: _tubeWorld.z },
      dir: { ...dir },
      depth: _tubeWorld.y,
      life: TORP_LIFE,
      owner: ship,
    });
    effects.splash(_tubeWorld.x, _tubeWorld.y, _tubeWorld.z, 0xbfe8f0, 8, 0.4);
  }
  return true;
}

// ─── Damage ──────────────────────────────────────────────────────────────

/** Beyond this, an impact is a near miss rather than a hit. */
export const DIRECT_HIT_RADIUS = 2.0;

const _blockWorld = new CANNON.Vec3();
/** Scratch distances, parallel to `ship.blocks`, reused between calls. */
let _dist: number[] = [];

/**
 * Apply damage at a world point.
 *
 * Finds the nearest live block, damages it directly, spreads reduced damage to
 * neighbours inside {@link SPLASH_RADIUS}, destroys anything that reaches zero,
 * and kicks the hull with an off-centre impulse so hits visibly stagger it.
 *
 * Returns false if nothing was close enough to hit.
 */
export function damageAt(
  ship: Ship,
  wx: number,
  wy: number,
  wz: number,
  amount: number,
  effects: Effects = nullEffects,
): boolean {
  if (!ship.alive) return false;

  if (_dist.length < ship.blocks.length) _dist = new Array<number>(ship.blocks.length);

  let best: ShipBlock | null = null;
  let bestD = Infinity;
  let bestIdx = -1;

  for (let i = 0; i < ship.blocks.length; i++) {
    const blk = ship.blocks[i]!;
    if (!blk.alive) continue;
    ship.body.quaternion.vmult(blk.local, _blockWorld);
    _blockWorld.vadd(ship.body.position, _blockWorld);
    const d = Math.hypot(_blockWorld.x - wx, _blockWorld.y - wy, _blockWorld.z - wz);
    _dist[i] = d;
    if (d < bestD) {
      bestD = d;
      best = blk;
      bestIdx = i;
    }
  }

  if (!best || bestD > DIRECT_HIT_RADIUS) return false;

  best.hp -= amount;
  effects.splash(wx, wy, wz, 0xff5a2a, 12, 0.7);

  // Splash damage to neighbours, falling off linearly with distance.
  for (let i = 0; i < ship.blocks.length; i++) {
    const blk = ship.blocks[i]!;
    if (!blk.alive || i === bestIdx) continue;
    const d = _dist[i]!;
    if (d < SPLASH_RADIUS) blk.hp -= SPLASH_DAMAGE * (1 - d / SPLASH_RADIUS);
  }

  for (const blk of ship.blocks) {
    if (blk.alive && blk.hp <= 0) {
      const at = destroyBlock(ship, blk);
      if (at) {
        effects.debris(at.x, at.y, at.z, BLOCKS[blk.type].color);
        effects.splash(at.x, at.y, at.z, 0xff8a3a, 10, 0.7);
        effects.splash(at.x, at.y, at.z, 0x444444, 6, 0.5);
      }
    }
  }

  // Off-centre impulse, so a hit forward of the beam really does slew the bow.
  // The impact arrives in world space but cannon-es wants it relative to the
  // body, so subtract the body position — this is the one call site where the
  // 0.6.2 → cannon-es convention change alters the argument rather than just
  // dropping it, and leaving it as a world point would scale the knock by the
  // ship's distance from the origin.
  const p = ship.body.position;
  ship.body.applyImpulse(
    new CANNON.Vec3((Math.random() - 0.5) * 250, -180, (Math.random() - 0.5) * 250),
    new CANNON.Vec3(wx - p.x, wy - p.y, wz - p.z),
  );
  return true;
}

export function sinkShip(ship: Ship, effects: Effects = nullEffects): void {
  if (!ship.alive) return;
  ship.alive = false;
  const p = ship.body.position;
  effects.splash(p.x, p.y, p.z, 0x222222, 30, 1.2);
}

// ─── Projectile update ───────────────────────────────────────────────────

/**
 * Swept hit detection.
 *
 * A shell at full power covers well over a metre per frame, so testing only
 * the endpoint would let rounds tunnel straight through a hull. Step along the
 * segment travelled in ~0.8 m increments instead.
 */
function sweep(
  from: Point3,
  to: Point3,
  ships: readonly Ship[],
  owner: Ship,
  onHit: (probe: Point3, target: Ship) => boolean,
): boolean {
  const travel = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.max(1, Math.ceil(travel / 0.8));
  const probe: Point3 = { x: 0, y: 0, z: 0 };

  for (let k = 1; k <= steps; k++) {
    const f = k / steps;
    probe.x = from.x + (to.x - from.x) * f;
    probe.y = from.y + (to.y - from.y) * f;
    probe.z = from.z + (to.z - from.z) * f;

    for (const target of ships) {
      if (target === owner || !target.alive) continue;
      const p = target.body.position;
      const cd = Math.hypot(probe.x - p.x, probe.y - p.y, probe.z - p.z);
      // Cheap bounding-sphere reject before the per-block search.
      if (cd > target.body.boundingRadius + 3) continue;
      if (onHit(probe, target)) return true;
    }
  }
  return false;
}

export function updateShells(
  combat: Combat,
  ships: readonly Ship[],
  dt: number,
  t: number,
  effects: Effects = nullEffects,
  waves: WaveField = waveHeight,
): void {
  for (let i = combat.shells.length - 1; i >= 0; i--) {
    const sh = combat.shells[i]!;
    const surf = WATER_LEVEL + waves(sh.pos.x, sh.pos.z, t);
    const underwater = sh.pos.y < surf;

    if (underwater) {
      if (!sh.wet) {
        sh.wet = true;
        effects.splash(sh.pos.x, surf, sh.pos.z, 0x9fd8e8, 10, 0.7);
        // The shooter watches its own fall of shot and corrects.
        spotCorrection(sh.spot, sh.pos);
      }
      // Water bleeds speed off fast, and buoyancy cuts the effective gravity.
      const drag = Math.pow(0.06, dt);
      sh.vel.x *= drag;
      sh.vel.y *= drag;
      sh.vel.z *= drag;
      sh.vel.y -= G * dt * 0.35;
      if (Math.random() < 0.4) effects.splash(sh.pos.x, sh.pos.y, sh.pos.z, 0xbfe8f0, 1, 0.2);
    } else {
      sh.vel.y -= G * dt * 1.3;
    }

    sh.prev.x = sh.pos.x;
    sh.prev.y = sh.pos.y;
    sh.prev.z = sh.pos.z;
    sh.pos.x += sh.vel.x * dt;
    sh.pos.y += sh.vel.y * dt;
    sh.pos.z += sh.vel.z * dt;
    sh.life -= dt;

    let dead = sh.life <= 0;
    const speedSq = sh.vel.x * sh.vel.x + sh.vel.y * sh.vel.y + sh.vel.z * sh.vel.z;
    if (underwater && speedSq < 9) dead = true;
    if (sh.pos.y < SEABED + 0.5) {
      effects.splash(sh.pos.x, SEABED + 0.5, sh.pos.z, 0x3a4d40, 6, 0.4);
      dead = true;
    }

    if (!dead) {
      dead = sweep(sh.prev, sh.pos, ships, sh.owner, (probe, target) =>
        damageAt(
          target,
          probe.x,
          probe.y,
          probe.z,
          SHELL_DAMAGE * (underwater ? 0.6 : 1),
          effects,
        ),
      );
    }

    if (dead) combat.shells.splice(i, 1);
  }
}

export function updateTorpedoes(
  combat: Combat,
  ships: readonly Ship[],
  dt: number,
  t: number,
  effects: Effects = nullEffects,
  waves: WaveField = waveHeight,
): void {
  for (let i = combat.torpedoes.length - 1; i >= 0; i--) {
    const tp = combat.torpedoes[i]!;
    tp.prev.x = tp.pos.x;
    tp.prev.y = tp.pos.y;
    tp.prev.z = tp.pos.z;

    tp.pos.x += tp.dir.x * TORP_SPEED * dt;
    tp.pos.y += tp.dir.y * TORP_SPEED * dt;
    tp.pos.z += tp.dir.z * TORP_SPEED * dt;

    // Hold launch depth, but never break the surface.
    const surf = WATER_LEVEL + waves(tp.pos.x, tp.pos.z, t);
    tp.pos.y = Math.min(tp.depth, surf - 0.6);
    tp.life -= dt;

    if (Math.random() < 0.7) effects.splash(tp.pos.x, tp.pos.y, tp.pos.z, 0xcdeef5, 1, 0.15);

    let dead = tp.life <= 0 || tp.pos.y < SEABED + 1;

    if (!dead) {
      dead = sweep(tp.prev, tp.pos, ships, tp.owner, (probe, target) => {
        if (!damageAt(target, probe.x, probe.y, probe.z, TORP_DAMAGE, effects)) return false;
        effects.splash(probe.x, probe.y, probe.z, 0xffd27f, 22, 1.1);
        effects.splash(probe.x, probe.y, probe.z, 0x9fd8e8, 18, 0.9);
        return true;
      });
    }

    if (dead) combat.torpedoes.splice(i, 1);
  }
}
