/**
 * Buoyancy, heel and water ingress.
 *
 * Pure physics — no renderer. Visual consequences (spray at the low rail when
 * water is coming in) are signalled back through the return value rather than
 * drawn here.
 */

import * as CANNON from 'cannon-es';

import {
  ANGULAR_DAMP,
  FLOOD_LIFT_LOSS,
  INGRESS_BASE,
  INGRESS_PER_DEG,
  PUMP_RATE,
  VERT_DRAG,
  WATER_LEVEL,
} from '../constants';
import { clamp, DEG } from '../math';
import type { Ship } from '../types';
import { waveHeight, type WaveField } from '../waves';
import { recountShip } from './compiler';

/** Metres below the still-water line. Never negative. */
export function shipDepth(ship: Ship): number {
  return Math.max(0, WATER_LEVEL - ship.body.position.y);
}

// Scratch vectors, reused every frame to keep the hot path allocation-free.
const _wp = new CANNON.Vec3();
const _rel = new CANNON.Vec3();
const _up = new CANNON.Vec3();
const _force = new CANNON.Vec3();
const _localUp = new CANNON.Vec3(0, 1, 0);

/**
 * Apply lift and drag.
 *
 * Two rules here were learned from real bugs and must not be undone:
 *
 * 1. **Lift stays at the sample point.** That off-centre application is
 *    exactly what generates the righting moment on a listing hull.
 * 2. **Drag is applied once, at the centre of mass.** Applying it per sample
 *    point sums into a phantom torque that slowly spins the hull. It is
 *    invisible on the surface — waves average it out as points enter and
 *    leave the water — but becomes a constant yaw the moment the boat is
 *    fully submerged and every point is wet at once.
 *
 * cannon-es note: `applyForce`'s second argument is a point *relative to the
 * centre of mass*, the opposite of cannon 0.6.2, where it was a world point.
 * So the sample point is used in two different frames here — `_rel` (the
 * rotated block offset) is what the force is applied at, and `_wp` (that same
 * offset plus the body position) is what the wave field is sampled at. Passing
 * `_wp` to `applyForce` would apply every lift force an entire ship-position
 * away from the hull, which looks plausible right up until you sail away from
 * the origin and the boat tears itself apart.
 */
export function applyBuoyancy(ship: Ship, t: number, waves: WaveField = waveHeight): void {
  const b = ship.body;
  const floatPower =
    (1 - ship.ballast * ship.ballastCut) * (1 - ship.flooding * FLOOD_LIFT_LOSS) * ship.buoyMul;

  let wet = 0;
  let total = 0;

  for (const blk of ship.blocks) {
    if (!blk.alive) continue;
    const half = blk.lift / 2;
    for (const sp of [blk.s1, blk.s2]) {
      total++;
      // _rel: offset from the centre of mass. _wp: the same point in world
      // space, which is the frame the wave field is defined in.
      b.quaternion.vmult(sp, _rel);
      _rel.vadd(b.position, _wp);
      const depth = WATER_LEVEL + waves(_wp.x, _wp.z, t) - _wp.y;
      if (depth > 0) {
        wet++;
        const submersion = Math.min(depth, 1.0);
        _force.set(0, submersion * half * floatPower, 0);
        b.applyForce(_force, _rel);
      }
    }
  }

  if (wet > 0) {
    const v = b.velocity;
    _force.set(-v.x * 18 * wet, -v.y * VERT_DRAG * wet, -v.z * 18 * wet);
    // No relative point: cannon-es defaults it to zero, i.e. the centre of
    // mass, so this contributes no torque. Under cannon 0.6.2 the equivalent
    // was passing `b.position`.
    b.applyForce(_force);
    // Water resists rotation too: damp harder the more of the hull is under.
    const frac = wet / Math.max(1, total);
    b.angularDamping = ANGULAR_DAMP + 0.1 * frac;
  } else {
    b.angularDamping = ANGULAR_DAMP;
  }
}

export interface FloodingResult {
  /** True while the hull is past its stability limit and shipping water. */
  takingWater: boolean;
  /** Heel angle from vertical, in degrees. */
  tiltDeg: number;
}

/**
 * Heel and water ingress.
 *
 * Tilt past the ship's stability limit lets water in; flooding costs
 * buoyancy, which makes it list further. The death spiral is intentional and
 * is recoverable only by levelling out — and only while the engines survive,
 * because the engines are also the pumps.
 */
export function updateFlooding(ship: Ship, dt: number): FloodingResult {
  if (!ship.alive) return { takingWater: false, tiltDeg: ship.tiltDeg };

  ship.body.quaternion.vmult(_localUp, _up);
  const tiltDeg = Math.acos(clamp(_up.y, -1, 1)) * DEG;
  ship.tiltDeg = tiltDeg;

  const over = tiltDeg - ship.capsizeAngle;
  let takingWater = false;

  if (over > 0) {
    takingWater = true;
    ship.flooding = Math.min(1, ship.flooding + (INGRESS_BASE + over * INGRESS_PER_DEG) * dt);
  } else if (ship.flooding > 0 && ship.engines > 0) {
    // Pumps only run if at least one engine survives.
    ship.flooding = Math.max(0, ship.flooding - PUMP_RATE * dt);
  }

  recountShip(ship);
  return { takingWater, tiltDeg };
}
