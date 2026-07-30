/**
 * Ballistics — where a shell will actually land.
 *
 * The single most important property here is that **one function predicts the
 * trajectory and everything else consumes it**: the player's reticle, the
 * velocity handed to a fired shell, and the AI's firing solution all call
 * `predictImpact`. That is why the reticle sits exactly where the shot goes,
 * and why aiming feels honest rather than approximate.
 *
 * Pure — no Three.js, no renderer. The prototype used `THREE.Vector3` here,
 * but only ever as a plain three-component vector.
 */

import * as CANNON from 'cannon';

import {
  B,
  BALLISTIC_MAX_STEPS,
  BALLISTIC_STEP,
  G,
  POWER_MAX,
  POWER_MIN,
  POWER_SEARCH_STEP,
  SHELL_GRAVITY_SCALE,
  SHELL_SPEED_MAX,
  SHELL_SPEED_MIN,
  WATER_LEVEL,
} from '../constants';
import type { RangeBand, Ship, ShipBlock } from '../types';
import { waveHeight, type WaveField } from '../waves';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Impact {
  point: Point3;
  /** Seconds of flight — what the AI needs in order to lead a moving target. */
  time: number;
}

export interface GunSolution {
  /** World-space muzzle position. */
  pos: CANNON.Vec3;
  /** World-space unit firing direction. */
  dir: CANNON.Vec3;
}

export function speedFromPower(p: number): number {
  return SHELL_SPEED_MIN + (SHELL_SPEED_MAX - SHELL_SPEED_MIN) * p;
}

/** Firing direction in ship-local space, from barrel elevation and traverse. */
export function localAimDir(elev: number, trav: number): CANNON.Vec3 {
  const ce = Math.cos(elev);
  return new CANNON.Vec3(Math.sin(trav) * ce, Math.sin(elev), Math.cos(trav) * ce);
}

/**
 * World-space muzzle point and direction for one gun block.
 *
 * The muzzle is placed at the barrel *tip* rather than the block centre, so it
 * tracks the aim — a shell never spawns inside its own turret.
 */
export function gunSolution(
  ship: Ship,
  gun: ShipBlock,
  elev: number,
  trav: number,
): GunSolution {
  const b = ship.body;
  const dirL = localAimDir(elev, trav);
  const dirW = new CANNON.Vec3();
  b.quaternion.vmult(dirL, dirW);
  dirW.normalize();

  const muzL = new CANNON.Vec3(
    gun.local.x + dirL.x * B * 0.95,
    gun.local.y + 0.15 + dirL.y * B * 0.95,
    gun.local.z + dirL.z * B * 0.95,
  );
  const muzW = new CANNON.Vec3();
  b.quaternion.vmult(muzL, muzW);
  muzW.vadd(b.position, muzW);

  return { pos: muzW, dir: dirW };
}

export function firstLiveGun(ship: Ship): ShipBlock | undefined {
  return ship.blocks.find((b) => b.alive && b.isCannon);
}

/**
 * Integrate the exact trajectory the shell will fly, and return where and when
 * it meets the water.
 *
 * Returns `null` if the ship has no live gun, or if the shell is still airborne
 * after {@link BALLISTIC_MAX_STEPS}.
 */
export function predictImpact(
  ship: Ship,
  speed: number,
  t: number,
  elev: number,
  trav: number,
  waves: WaveField = waveHeight,
): Impact | null {
  const gun = firstLiveGun(ship);
  if (!gun) return null;

  const sol = gunSolution(ship, gun, elev, trav);
  let px = sol.pos.x;
  let py = sol.pos.y;
  let pz = sol.pos.z;
  // Only the vertical component changes in flight — there is no air drag on
  // a shell above the water, which is what makes the trajectory a clean
  // parabola the AI can solve against.
  const vx = sol.dir.x * speed;
  let vy = sol.dir.y * speed;
  const vz = sol.dir.z * speed;

  const step = BALLISTIC_STEP;
  for (let i = 0; i < BALLISTIC_MAX_STEPS; i++) {
    vy -= G * step * SHELL_GRAVITY_SCALE;
    px += vx * step;
    py += vy * step;
    pz += vz * step;
    if (py < WATER_LEVEL + waves(px, pz, t)) {
      return { point: { x: px, y: py, z: pz }, time: i * step };
    }
  }
  return null;
}

/** Horizontal distance from a ship to an impact point. */
export function rangeTo(ship: Ship, hit: Impact | null): number {
  if (!hit) return 0;
  return Math.hypot(hit.point.x - ship.body.position.x, hit.point.z - ship.body.position.z);
}

export interface PowerSolution {
  power: number;
  /** Metres between the best reachable range and the one asked for. */
  err: number;
}

/**
 * Search for the power setting that lands a shell at `wantDist`.
 *
 * A coarse linear sweep rather than an analytic inverse — the trajectory
 * includes the wave surface, so there is no closed form, and 31 samples is
 * cheap enough to run a few times a second.
 */
export function solvePowerForRange(
  ship: Ship,
  wantDist: number,
  t: number,
  elev: number,
  waves: WaveField = waveHeight,
): PowerSolution {
  let best = 0.5;
  let bestErr = Infinity;
  for (let p = POWER_MIN; p <= POWER_MAX; p += POWER_SEARCH_STEP) {
    const hit = predictImpact(ship, speedFromPower(p), t, elev, 0, waves);
    if (!hit) continue;
    const err = Math.abs(rangeTo(ship, hit) - wantDist);
    if (err < bestErr) {
      bestErr = err;
      best = p;
    }
  }
  return { power: best, err: bestErr };
}

/** The range band a ship can actually reach at its current elevation. */
export function rangeBand(
  ship: Ship,
  t: number,
  elev: number,
  waves: WaveField = waveHeight,
): RangeBand {
  const lo = predictImpact(ship, speedFromPower(POWER_MIN), t, elev, 0, waves);
  const hi = predictImpact(ship, speedFromPower(POWER_MAX), t, elev, 0, waves);
  return { min: rangeTo(ship, lo), max: rangeTo(ship, hi) };
}
