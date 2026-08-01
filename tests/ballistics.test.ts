/**
 * Ballistics invariants.
 *
 * The property worth protecting: the reticle, the shell and the AI's firing
 * solution all read `predictImpact`, so the crosshair sits exactly where the
 * round lands. If these ever diverge, aiming stops feeling honest and no
 * amount of tuning elsewhere will fix it.
 */

import * as CANNON from 'cannon-es';
import { describe, expect, it } from 'vitest';

import {
  firstLiveGun,
  gunSolution,
  localAimDir,
  predictImpact,
  rangeBand,
  rangeTo,
  solvePowerForRange,
  speedFromPower,
} from '../src/engine/combat/ballistics';
import {
  AI_ELEV,
  ELEV_MAX,
  POWER_MAX,
  POWER_MIN,
  SHELL_SPEED_MAX,
  SHELL_SPEED_MIN,
  TRAV_LIMIT,
} from '../src/engine/constants';
import { createPhysicsWorld } from '../src/engine/physics/world';
import { buildShip } from '../src/engine/ship/compiler';
import { starterDesign } from '../src/engine/ship/design';
import type { Ship } from '../src/engine/types';
import { flatWater } from '../src/engine/waves';

function gunship(x = 0, z = 0, heading = 0): Ship {
  const { world } = createPhysicsWorld();
  return buildShip(world, starterDesign(), { x, z, heading }, true);
}

describe('speedFromPower', () => {
  it('spans the configured shell speed range', () => {
    expect(speedFromPower(0)).toBe(SHELL_SPEED_MIN);
    expect(speedFromPower(1)).toBe(SHELL_SPEED_MAX);
    expect(speedFromPower(0.5)).toBeCloseTo((SHELL_SPEED_MIN + SHELL_SPEED_MAX) / 2, 10);
  });

  it('is monotonic', () => {
    for (let p = 0; p < 1; p += 0.05) {
      expect(speedFromPower(p + 0.05)).toBeGreaterThan(speedFromPower(p));
    }
  });
});

describe('localAimDir', () => {
  it('is a unit vector at every elevation and traverse', () => {
    for (let e = 0; e <= ELEV_MAX; e += 0.1) {
      for (let tv = -TRAV_LIMIT; tv <= TRAV_LIMIT; tv += 0.1) {
        const d = localAimDir(e, tv);
        expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 10);
      }
    }
  });

  it('points down the bow at zero elevation and traverse', () => {
    const d = localAimDir(0, 0);
    expect(d.x).toBeCloseTo(0, 10);
    expect(d.y).toBeCloseTo(0, 10);
    expect(d.z).toBeCloseTo(1, 10); // +Z is forward
  });

  it('raises the muzzle as elevation increases', () => {
    expect(localAimDir(0.5, 0).y).toBeGreaterThan(localAimDir(0.2, 0).y);
  });
});

describe('gunSolution', () => {
  it('puts the muzzle outside the turret, in the direction of aim', () => {
    const ship = gunship();
    const gun = firstLiveGun(ship);
    expect(gun).toBeDefined();

    const sol = gunSolution(ship, gun!, 0, 0);
    // Unit direction.
    expect(Math.hypot(sol.dir.x, sol.dir.y, sol.dir.z)).toBeCloseTo(1, 10);
    // Muzzle is ahead of the gun block's own centre, not inside it.
    const gunWorldZ = ship.body.position.z + gun!.local.z;
    expect(sol.pos.z).toBeGreaterThan(gunWorldZ);
  });

  it('follows the hull when it moves and turns', () => {
    const ship = gunship(120, -80, Math.PI / 2);
    const gun = firstLiveGun(ship)!;
    const sol = gunSolution(ship, gun, 0, 0);

    // Heading is +90° about Y, so the bow — and the shot — points along +X.
    expect(sol.dir.x).toBeCloseTo(1, 6);
    expect(sol.dir.z).toBeCloseTo(0, 6);
    // Muzzle travelled with the hull.
    expect(Math.hypot(sol.pos.x - 120, sol.pos.z + 80)).toBeLessThan(6);
  });
});

describe('predictImpact', () => {
  it('lands further downrange with more power', () => {
    const ship = gunship();
    let previous = 0;
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const hit = predictImpact(ship, speedFromPower(p), 0, AI_ELEV, 0, flatWater);
      expect(hit).not.toBeNull();
      const range = rangeTo(ship, hit);
      expect(range).toBeGreaterThan(previous);
      previous = range;
    }
  });

  it('lands on the water surface, not through it', () => {
    const ship = gunship();
    const hit = predictImpact(ship, speedFromPower(0.6), 0, AI_ELEV, 0, flatWater);
    expect(hit).not.toBeNull();
    // The integrator stops on the first step below the surface, so the shell
    // is at most one step's fall past it.
    expect(hit!.point.y).toBeLessThanOrEqual(0);
    expect(hit!.point.y).toBeGreaterThan(-3);
  });

  it('reports a plausible time of flight for target leading', () => {
    const ship = gunship();
    const slow = predictImpact(ship, speedFromPower(0.2), 0, AI_ELEV, 0, flatWater)!;
    const fast = predictImpact(ship, speedFromPower(0.9), 0, AI_ELEV, 0, flatWater)!;
    expect(slow.time).toBeGreaterThan(0);
    // A faster shell at the same elevation stays up longer, because it is
    // travelling further before gravity brings it down.
    expect(fast.time).toBeGreaterThan(slow.time);
    expect(fast.time).toBeLessThan(10);
  });

  it('throws the shot to port and starboard with traverse', () => {
    const ship = gunship();
    const left = predictImpact(ship, speedFromPower(0.6), 0, AI_ELEV, -TRAV_LIMIT, flatWater)!;
    const right = predictImpact(ship, speedFromPower(0.6), 0, AI_ELEV, TRAV_LIMIT, flatWater)!;
    expect(left.point.x).toBeLessThan(0);
    expect(right.point.x).toBeGreaterThan(0);
  });

  it('returns null when every gun is gone', () => {
    const ship = gunship();
    for (const b of ship.blocks) if (b.isCannon) b.alive = false;
    expect(predictImpact(ship, speedFromPower(0.5), 0, AI_ELEV, 0)).toBeNull();
  });
});

describe('solvePowerForRange round-trip', () => {
  /**
   * The core invariant: ask for a range, fire at the power it returns, and
   * land there. This is what keeps the AI's shots honest and the player's
   * reticle truthful.
   */
  it('hits the range it was asked for, across the whole band', () => {
    const ship = gunship();
    const band = rangeBand(ship, 0, AI_ELEV, flatWater);
    expect(band.max).toBeGreaterThan(band.min);

    // Stay inside the band; the solver cannot invent range it does not have.
    for (let f = 0.1; f <= 0.9; f += 0.1) {
      const want = band.min + (band.max - band.min) * f;
      const sol = solvePowerForRange(ship, want, 0, AI_ELEV, flatWater);

      expect(sol.power).toBeGreaterThanOrEqual(POWER_MIN);
      expect(sol.power).toBeLessThanOrEqual(POWER_MAX);

      const hit = predictImpact(ship, speedFromPower(sol.power), 0, AI_ELEV, 0, flatWater);
      expect(hit).not.toBeNull();

      const actual = rangeTo(ship, hit);
      // The solver sweeps power in steps of 0.03, so it lands within about
      // half a step's worth of range. Tolerance scales with the band.
      expect(Math.abs(actual - want)).toBeLessThan((band.max - band.min) * 0.05);
      // ...and the error it reports must match the error it actually has.
      expect(sol.err).toBeCloseTo(Math.abs(actual - want), 6);
    }
  });

  it('reports a large error when asked for a range it cannot reach', () => {
    const ship = gunship();
    const band = rangeBand(ship, 0, AI_ELEV, flatWater);
    const sol = solvePowerForRange(ship, band.max * 5, 0, AI_ELEV, flatWater);
    // It still returns its best effort — but says how far off it is, which is
    // what stops the AI firing hopeless shots.
    expect(sol.err).toBeGreaterThan(band.max);
    expect(sol.power).toBeCloseTo(POWER_MAX, 1);
  });

  it('works from a hull that has moved away from the origin', () => {
    const ship = gunship(-310, 275, 1.2);
    const band = rangeBand(ship, 5.5, AI_ELEV, flatWater);
    const want = (band.min + band.max) / 2;
    const sol = solvePowerForRange(ship, want, 5.5, AI_ELEV, flatWater);
    const hit = predictImpact(ship, speedFromPower(sol.power), 5.5, AI_ELEV, 0, flatWater);

    expect(hit).not.toBeNull();
    expect(Math.abs(rangeTo(ship, hit) - want)).toBeLessThan((band.max - band.min) * 0.05);
  });
});

describe('rangeBand', () => {
  it('brackets what the gun can actually reach', () => {
    const ship = gunship();
    const band = rangeBand(ship, 0, AI_ELEV, flatWater);
    expect(band.min).toBeGreaterThan(0);
    expect(band.max).toBeGreaterThan(band.min);

    const minShot = rangeTo(ship, predictImpact(ship, speedFromPower(POWER_MIN), 0, AI_ELEV, 0, flatWater));
    const maxShot = rangeTo(ship, predictImpact(ship, speedFromPower(POWER_MAX), 0, AI_ELEV, 0, flatWater));
    expect(band.min).toBeCloseTo(minShot, 6);
    expect(band.max).toBeCloseTo(maxShot, 6);
  });

  it('collapses to nothing when the guns are destroyed', () => {
    const ship = gunship();
    for (const b of ship.blocks) if (b.isCannon) b.alive = false;
    const band = rangeBand(ship, 0, AI_ELEV, flatWater);
    expect(band.min).toBe(0);
    expect(band.max).toBe(0);
  });

  it('is unaffected by which way the ship is pointing', () => {
    const flat = (h: number) => {
      const { world } = createPhysicsWorld();
      const s = buildShip(world, starterDesign(), { x: 0, z: 0, heading: h }, true);
      s.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), h);
      return rangeBand(s, 0, AI_ELEV, flatWater);
    };
    const north = flat(0);
    const east = flat(Math.PI / 2);
    expect(east.min).toBeCloseTo(north.min, 4);
    expect(east.max).toBeCloseTo(north.max, 4);
  });
});
