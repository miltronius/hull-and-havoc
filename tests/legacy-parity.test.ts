/**
 * Differential test: the ported physics against the prototype's, numerically.
 *
 * Phase 1 claims to be a *mechanical* extraction — same behaviour, new file
 * layout. This test makes that claim falsifiable instead of aspirational. It
 * slices `waveHeight` and `applyBuoyancy` verbatim out of the frozen
 * `legacy/hull-and-havoc-v3.html`, evaluates them, and runs them against the
 * same compiled ship as the ported versions, comparing the accumulated force
 * and torque exactly.
 *
 * If this fails, the port changed the simulation. That is almost never what
 * was intended.
 *
 * Phase 2 (cannon-es, three r160+) is where this file earns its keep: it is
 * the only thing that can tell you whether the `applyForce` relative-point
 * change was translated correctly, because the symptom otherwise is "the boat
 * feels a bit odd".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import * as CANNON from 'cannon';
import { beforeAll, describe, expect, it } from 'vitest';

import * as THREE from 'three';

import { predictImpact, speedFromPower } from '../src/engine/combat/ballistics';
import {
  ANGULAR_DAMP,
  B,
  FLOOD_LIFT_LOSS,
  G,
  SHELL_SPEED_MAX,
  SHELL_SPEED_MIN,
  VERT_DRAG,
  WATER_LEVEL,
} from '../src/engine/constants';
import { createPhysicsWorld } from '../src/engine/physics/world';
import { applyBuoyancy } from '../src/engine/ship/buoyancy';
import { buildShip } from '../src/engine/ship/compiler';
import { starterDesign } from '../src/engine/ship/design';
import type { Ship } from '../src/engine/types';
import { waveHeight } from '../src/engine/waves';

const LEGACY = fileURLToPath(new URL('../legacy/hull-and-havoc-v3.html', import.meta.url));

type LegacyWave = (x: number, z: number, t: number) => number;
type LegacyBuoyancy = (ship: Ship, t: number) => void;
type LegacyPredict = (
  ship: Ship,
  speed: number,
  t: number,
  elev: number,
  trav: number,
) => { point: { x: number; y: number; z: number }; time: number } | null;

let legacyWaveHeight: LegacyWave;
let legacyApplyBuoyancy: LegacyBuoyancy;
let legacyPredictImpact: LegacyPredict;

beforeAll(() => {
  const lines = readFileSync(LEGACY, 'utf8').split(/\r?\n/);
  const slice = (a: number, b: number) => lines.slice(a - 1, b).join('\n');

  const waveSrc = slice(577, 583); // function waveHeight(x, z, t) { ... }
  const buoySrc = slice(1184, 1220); // const _wp = ...; function applyBuoyancy(...)
  const ballSrc = slice(1461, 1505); // speedFromPower, localAimDir, gunSolution, predictImpact

  // Guard against the frozen file being edited out from under these ranges.
  expect(waveSrc).toContain('function waveHeight');
  expect(buoySrc).toContain('function applyBuoyancy');
  expect(buoySrc).toContain('DRAG must act at the centre of mass');
  expect(ballSrc).toContain('function predictImpact');
  expect(ballSrc).toContain('function gunSolution');

  const factory = new Function(
    'CANNON',
    'THREE',
    'WATER_LEVEL',
    'FLOOD_LIFT_LOSS',
    'VERT_DRAG',
    'ANGULAR_DAMP',
    'B',
    'G',
    'SHELL_SPEED_MIN',
    'SHELL_SPEED_MAX',
    `${waveSrc}\n${buoySrc}\n${ballSrc}\n` +
      'return { waveHeight, applyBuoyancy, predictImpact, speedFromPower };',
  ) as (...args: unknown[]) => {
    waveHeight: LegacyWave;
    applyBuoyancy: LegacyBuoyancy;
    predictImpact: LegacyPredict;
    speedFromPower: (p: number) => number;
  };

  const legacy = factory(
    CANNON,
    THREE,
    WATER_LEVEL,
    FLOOD_LIFT_LOSS,
    VERT_DRAG,
    ANGULAR_DAMP,
    B,
    G,
    SHELL_SPEED_MIN,
    SHELL_SPEED_MAX,
  );
  legacyWaveHeight = legacy.waveHeight;
  legacyApplyBuoyancy = legacy.applyBuoyancy;
  legacyPredictImpact = legacy.predictImpact;

  // The port replaced THREE.Vector3 with scalars; confirm the scalar helper
  // it shares with the legacy code still agrees.
  for (let i = 0; i <= 10; i++) {
    expect(speedFromPower(i / 10)).toBe(legacy.speedFromPower(i / 10));
  }
});

describe('waveHeight parity', () => {
  it('matches the prototype exactly across space and time', () => {
    for (let i = 0; i < 200; i++) {
      // Deliberately includes points far from the origin: the visible surface
      // once desynced from the physics surface the further you sailed out.
      const x = ((i * 37) % 900) - 450;
      const z = ((i * 61) % 900) - 450;
      const t = (i * 0.37) % 60;
      expect(waveHeight(x, z, t)).toBe(legacyWaveHeight(x, z, t));
    }
  });
});

describe('applyBuoyancy parity', () => {
  interface Accum {
    force: [number, number, number];
    torque: [number, number, number];
    angularDamping: number;
  }

  function measure(ship: Ship, t: number, fn: (s: Ship, t: number) => void): Accum {
    ship.body.force.set(0, 0, 0);
    ship.body.torque.set(0, 0, 0);
    ship.body.angularDamping = ANGULAR_DAMP;
    fn(ship, t);
    const { force, torque } = ship.body;
    return {
      force: [force.x, force.y, force.z],
      torque: [torque.x, torque.y, torque.z],
      angularDamping: ship.body.angularDamping,
    };
  }

  /**
   * Exercises the states that actually differ: floating level, heeled,
   * partly flooded, ballasted down, fully submerged, and well away from the
   * origin where the wave field is not near-zero.
   */
  const cases: Array<{
    name: string;
    setup: (ship: Ship) => void;
    t: number;
  }> = [
    { name: 'level at the surface', setup: () => {}, t: 0 },
    {
      name: 'heeled 25 degrees',
      setup: (s) => s.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), 0.436),
      t: 3.1,
    },
    {
      name: 'pitched and yawed',
      setup: (s) => s.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0.3, 0.8, 0.5), 0.9),
      t: 7.7,
    },
    { name: 'half ballasted', setup: (s) => { s.ballast = 0.5; }, t: 2.2 },
    { name: 'flooding', setup: (s) => { s.flooding = 0.6; }, t: 5.5 },
    {
      name: 'fully submerged with way on',
      setup: (s) => {
        s.body.position.set(0, -30, 0);
        s.body.velocity.set(3.2, -1.4, -2.7);
        s.ballast = 1;
      },
      t: 11.3,
    },
    {
      name: 'far from the origin',
      setup: (s) => {
        s.body.position.set(412, -0.4, -377);
        s.body.velocity.set(-1.1, 0.6, 2.3);
      },
      t: 19.9,
    },
    {
      name: 'battle damaged',
      setup: (s) => {
        // Kill a few blocks; dead blocks must contribute no lift at all.
        s.blocks[0]!.alive = false;
        s.blocks[7]!.alive = false;
        s.blocks[15]!.alive = false;
      },
      t: 4.4,
    },
    {
      name: 'clear of the water',
      setup: (s) => s.body.position.set(0, 40, 0),
      t: 1.0,
    },
  ];

  for (const c of cases) {
    it(`matches the prototype — ${c.name}`, () => {
      const { world } = createPhysicsWorld();
      const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
      c.setup(ship);

      // Same ship, same state, run twice — so any difference is the code.
      const ported = measure(ship, c.t, applyBuoyancy);
      const original = measure(ship, c.t, legacyApplyBuoyancy);

      expect(ported.force).toEqual(original.force);
      expect(ported.torque).toEqual(original.torque);
      expect(ported.angularDamping).toBe(original.angularDamping);
    });
  }

  it('produces no force at all when the hull is clear of the water', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
    ship.body.position.set(0, 40, 0);
    const a = measure(ship, 1, applyBuoyancy);
    expect(a.force).toEqual([0, 0, 0]);
    expect(a.torque).toEqual([0, 0, 0]);
    expect(a.angularDamping).toBe(ANGULAR_DAMP);
  });
});

describe('predictImpact parity', () => {
  /**
   * The port replaced the prototype's `THREE.Vector3` bookkeeping with plain
   * scalars so ballistics could run headlessly. Same arithmetic, same order —
   * and since the reticle, the fired shell and the AI's solver all read this
   * one function, any drift here would desync the crosshair from the shot.
   */
  it('lands shells in exactly the same place as the prototype', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);

    let compared = 0;
    for (const power of [0.08, 0.25, 0.5, 0.75, 1.0]) {
      for (const elevDeg of [0, 10, 24, 42]) {
        for (const travDeg of [-34, 0, 17, 34]) {
          for (const t of [0, 4.3, 17.6]) {
            const speed = speedFromPower(power);
            const elev = (elevDeg * Math.PI) / 180;
            const trav = (travDeg * Math.PI) / 180;

            const ported = predictImpact(ship, speed, t, elev, trav);
            const original = legacyPredictImpact(ship, speed, t, elev, trav);

            expect(ported === null).toBe(original === null);
            if (ported && original) {
              expect(ported.point.x).toBe(original.point.x);
              expect(ported.point.y).toBe(original.point.y);
              expect(ported.point.z).toBe(original.point.z);
              expect(ported.time).toBe(original.time);
              compared++;
            }
          }
        }
      }
    }
    // Guard against the loops silently producing nothing.
    expect(compared).toBeGreaterThan(200);
  });

  it('agrees from a moved, heeled and yawed ship', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
    ship.body.position.set(-233, 0.6, 188);
    ship.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0.2, 0.9, 0.4), 1.15);

    const speed = speedFromPower(0.6);
    const elev = (18 * Math.PI) / 180;
    const ported = predictImpact(ship, speed, 9.4, elev, 0.2);
    const original = legacyPredictImpact(ship, speed, 9.4, elev, 0.2);

    expect(ported).not.toBeNull();
    expect(ported!.point.x).toBe(original!.point.x);
    expect(ported!.point.y).toBe(original!.point.y);
    expect(ported!.point.z).toBe(original!.point.z);
  });

  it('returns null once the ship has no live gun', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
    for (const b of ship.blocks) if (b.isCannon) b.alive = false;

    expect(predictImpact(ship, speedFromPower(0.5), 0, 0.2, 0)).toBeNull();
    expect(legacyPredictImpact(ship, speedFromPower(0.5), 0, 0.2, 0)).toBeNull();
  });
});
