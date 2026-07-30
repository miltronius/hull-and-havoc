/**
 * Enemy AI.
 *
 * Three behaviours, all of them derived from the same ballistics the player
 * uses rather than from cheats:
 *
 * 1. **Know your own range.** It recomputes its reachable band a few times a
 *    second and manoeuvres to sit inside it, rather than charging blindly.
 * 2. **Lead the target.** It solves for time of flight and aims where the
 *    player *will* be, not where they are.
 * 3. **Watch your fall of shot.** A running `aimBias` is corrected from where
 *    its own splashes land (see `spotting.ts`), so it stops bracketing after
 *    a couple of rounds.
 *
 * Pure simulation — no renderer.
 */

import * as CANNON from 'cannon';

import { AI_ELEV, ENGINE_THRUST, TURN_PER_ENGINE } from '../constants';
import type { Ship } from '../types';
import type { WaveField } from '../waves';
import { waveHeight } from '../waves';
import {
  predictImpact,
  rangeBand,
  solvePowerForRange,
  speedFromPower,
} from './ballistics';
import type { Effects } from './effects';
import { nullEffects } from './effects';
import { fire, type Combat } from './weapons';

/** How often the AI re-derives its own gun range, in seconds. */
export const RANGE_REFRESH = 0.4;
/** Sweet spot inside the band, so it always has a firing solution in hand. */
export const IDEAL_MIN_FACTOR = 1.25;
export const IDEAL_MAX_FACTOR = 0.8;
/** Heading error it will tolerate before shooting, in radians. */
export const FIRE_ARC = 0.22;
/** Reject firing solutions worse than this many metres. */
export const SOLUTION_TOLERANCE = 12;
/** Fallback shell speed used only to seed the first lead estimate. */
const NOMINAL_SHELL_SPEED = 70;

const _fwd = new CANNON.Vec3();
const _localZ = new CANNON.Vec3(0, 0, 1);
const _thrust = new CANNON.Vec3();

export interface AiContext {
  combat: Combat;
  /** Simulation clock, shared with the ballistics solver. */
  t: number;
  effects?: Effects;
  waves?: WaveField;
}

/**
 * Drive one enemy ship for a frame.
 *
 * Mutates `self` (helm forces, reload, `aimBias`, cached range band) and may
 * push shells into `ctx.combat`.
 */
export function enemyAI(self: Ship, target: Ship, dt: number, ctx: AiContext): void {
  if (!self.alive || !target.alive) return;

  const waves = ctx.waves ?? waveHeight;
  const effects = ctx.effects ?? nullEffects;
  const e = self.body;
  const p = target.body;

  const dist = Math.hypot(p.position.x - e.position.x, p.position.z - e.position.z);

  // ── know your own gun range ──
  self.rangeTimer -= dt;
  if (self.rangeTimer <= 0 || !self.band) {
    self.band = rangeBand(self, ctx.t, AI_ELEV, waves);
    self.rangeTimer = RANGE_REFRESH;
  }
  const band = self.band;
  const idealMin = band.min * IDEAL_MIN_FACTOR;
  const idealMax = band.max * IDEAL_MAX_FACTOR;

  // ── lead the target: aim where the player will be ──
  const seed = solvePowerForRange(self, dist, ctx.t, AI_ELEV, waves);
  const flight = predictImpact(self, speedFromPower(seed.power), ctx.t, AI_ELEV, 0, waves);
  const tof = flight ? flight.time : dist / NOMINAL_SHELL_SPEED;
  const leadX = p.position.x + p.velocity.x * tof;
  const leadZ = p.position.z + p.velocity.z * tof;
  const aimDist = Math.hypot(leadX - e.position.x, leadZ - e.position.z);
  const targetAng = Math.atan2(leadX - e.position.x, leadZ - e.position.z);

  // ── turn onto the bearing ──
  e.quaternion.vmult(_localZ, _fwd);
  const curAng = Math.atan2(_fwd.x, _fwd.z);
  let da = targetAng - curAng;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  e.torque.y += da * Math.max(self.engines, 1) * TURN_PER_ENGINE * 1.4;

  // ── manoeuvre into its own effective range ──
  const fwdForce = dist > idealMax ? 1 : dist < idealMin ? -0.6 : 0.15;
  _thrust.set(0, 0, self.engines * ENGINE_THRUST * fwdForce);
  e.quaternion.vmult(_thrust, _thrust);
  e.applyForce(_thrust, e.position);

  // ── fire only with a valid solution, corrected by observed misses ──
  const wanted = aimDist * self.aimBias;
  if (self.reload <= 0 && Math.abs(da) < FIRE_ARC && wanted <= band.max && wanted >= band.min) {
    const sol = solvePowerForRange(self, wanted, ctx.t, AI_ELEV, waves);
    if (sol.err < SOLUTION_TOLERANCE) {
      fire(self, ctx.combat, {
        speed: speedFromPower(sol.power),
        elev: AI_ELEV,
        effects,
        spot: {
          shooter: self,
          from: { x: e.position.x, y: e.position.y, z: e.position.z },
          wanted: aimDist,
        },
      });
    }
  }
}
