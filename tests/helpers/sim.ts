/**
 * Headless simulation harness.
 *
 * Compiles a real ship into a real `CANNON.World` and steps it with no
 * renderer, no DOM and no browser. This is the payoff of splitting
 * `compileShip` into `buildShip` (pure) and `attachShipView` (Three.js):
 * behaviours that were originally verified by eye, or by throwaway Node
 * snippets during the prototype, become assertions that run in CI.
 *
 * The per-frame call order mirrors `loop()` exactly — control, flooding,
 * buoyancy, then `world.step`. Any divergence here would make the tests
 * measure something the game never does.
 */

import * as CANNON from 'cannon-es';

import { createPhysicsWorld, stepWorld } from '../../src/engine/physics/world';
import { applyBuoyancy, shipDepth, updateFlooding } from '../../src/engine/ship/buoyancy';
import { buildShip } from '../../src/engine/ship/compiler';
import { key } from '../../src/engine/ship/design';
import { applyThrust, applyTrim, updateDepthControl } from '../../src/engine/ship/helm';
import type { Design, Ship } from '../../src/engine/types';
import { flatWater, waveHeight, type WaveField } from '../../src/engine/waves';

export const STEP = 1 / 60;

export interface Helm {
  /** -1..1, positive ahead. */
  throttle?: number;
  /** -1..1, positive to starboard. */
  steer?: number;
  /** +1 dive, -1 surface, 0 hold. */
  depth?: number;
  /** +1 bow up, -1 bow down. */
  pitch?: number;
  /** +1 roll to port, -1 to starboard. */
  roll?: number;
}

export interface Rig {
  world: CANNON.World;
  ship: Ship;
  /** Seconds elapsed. */
  t: number;
}

export interface RigOptions {
  waves?: WaveField;
  isPlayer?: boolean;
}

export function rig(design: Design, options: RigOptions = {}): Rig & { waves: WaveField } {
  const { world } = createPhysicsWorld();
  const ship = buildShip(
    world,
    design,
    { x: 0, z: 0, heading: 0 },
    options.isPlayer ?? true,
  );
  return { world, ship, t: 0, waves: options.waves ?? flatWater };
}

/**
 * Advance the simulation. Returns the rig so calls chain.
 *
 * `helm` may be a fixed command or a function of elapsed time, which is how
 * the depth-hold test holds "dive" for a while and then releases it.
 */
export function run(
  r: Rig & { waves: WaveField },
  seconds: number,
  helm: Helm | ((t: number) => Helm) = {},
  onFrame?: (r: Rig) => void,
): Rig & { waves: WaveField } {
  const frames = Math.round(seconds / STEP);
  for (let i = 0; i < frames; i++) {
    const cmd = typeof helm === 'function' ? helm(r.t) : helm;

    applyThrust(r.ship, cmd.throttle ?? 0, cmd.steer ?? 0);
    updateDepthControl(r.ship, STEP, cmd.depth ?? 0);
    applyTrim(r.ship, cmd.pitch ?? 0, cmd.roll ?? 0);
    updateFlooding(r.ship, STEP);
    applyBuoyancy(r.ship, r.t, r.waves);

    stepWorld(r.world, STEP);
    r.t += STEP;
    onFrame?.(r);
  }
  return r;
}

// ─── Measurements ────────────────────────────────────────────────────────

/** Compass heading in radians, from the hull's forward axis. */
export function heading(ship: Ship): number {
  const q = ship.body.quaternion;
  // Rotate local +Z into world space without allocating a cannon Vec3.
  const { x, y, z, w } = q;
  const fx = 2 * (x * z + w * y);
  const fz = 1 - 2 * (x * x + y * y);
  return Math.atan2(fx, fz);
}

/** Smallest signed angle between two headings, in degrees. */
export function headingDeltaDeg(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return (d * 180) / Math.PI;
}

export function depth(ship: Ship): number {
  return shipDepth(ship);
}

/** Min, max and range of a sampled series — for "did it settle?" assertions. */
export function spread(samples: number[]): { min: number; max: number; range: number } {
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  return { min, max, range: max - min };
}

// ─── Test designs ────────────────────────────────────────────────────────

/**
 * A hull with real dive capability *and* enough stability to survive using it.
 *
 * The stock starter ship carries one tank and cannot submerge
 * (`canDive === false`), so depth-control tests need a purpose-built boat.
 * Note the tanks sit in the bottom layer, not stacked in a conning tower: an
 * earlier version of this fixture put four tanks on top, which raised the mass
 * centroid enough that the hull heeled past its stability limit while
 * submerged, flooded, and rode the death spiral to the seabed. That is the
 * simulation working correctly — but it makes for a useless depth-hold
 * fixture. Keep the mass low and the beam wide.
 */
export function diverDesign(): Design {
  const d: Design = new Map();
  for (let x = -1; x <= 1; x++) {
    for (let z = -2; z <= 2; z++) d.set(key(x, 0, z), 'hull');
  }
  // Four tanks -> ballastCut clamps to 0.9, so flooding kills nearly all lift.
  // Placed low and symmetrically so the boat stays upright when it dives.
  d.set(key(-1, 0, -1), 'ballast');
  d.set(key(1, 0, -1), 'ballast');
  d.set(key(-1, 0, 1), 'ballast');
  d.set(key(1, 0, 1), 'ballast');
  d.set(key(0, 1, -2), 'engine');
  return d;
}

/**
 * A perfectly symmetric submerged hull — flat, wide, and balanced in both
 * axes, with nothing above the waterline.
 *
 * This is the fixture for the phantom-yaw regression. The point of that test
 * is that a submerged hull with no input must not rotate; any fore-aft or
 * athwartships mass offset would introduce a genuine pitching or rolling
 * moment and mask the drag bug we are actually watching for. So: no
 * superstructure, tanks placed in symmetric pairs, mass centroid dead centre.
 */
export function symmetricDiverDesign(): Design {
  const d: Design = new Map();
  for (let x = -1; x <= 1; x++) {
    for (let z = -2; z <= 2; z++) d.set(key(x, 0, z), 'hull');
  }
  d.set(key(-1, 0, -1), 'ballast');
  d.set(key(1, 0, -1), 'ballast');
  d.set(key(-1, 0, 1), 'ballast');
  d.set(key(1, 0, 1), 'ballast');
  return d;
}

/**
 * Deliberately unstable: narrow beam with armour stacked off the centreline,
 * so it lists to starboard, heels past its limit, and floods. Used to test the
 * ingress / pump / death-spiral path.
 */
export function topHeavyDesign(): Design {
  const d: Design = new Map();
  for (let z = -2; z <= 2; z++) {
    d.set(key(0, 0, z), 'hull');
    d.set(key(1, 0, z), 'hull');
  }
  // All the weight up high and to one side.
  d.set(key(1, 1, 0), 'armor');
  d.set(key(1, 2, 0), 'armor');
  d.set(key(1, 1, 1), 'armor');
  d.set(key(0, 1, 0), 'engine');
  return d;
}

/**
 * Force a known attitude and heading.
 *
 * The trim-isolation test needs a hull held at a *fixed* heel — driving it
 * there with roll input instead produces a continuously tumbling body, which
 * measures nothing. Composes heading (yaw about world Y) with heel (roll about
 * the body's own forward axis).
 */
export function setAttitude(ship: Ship, heelDeg: number, headingRad = 0): void {
  const yaw = new CANNON.Quaternion();
  yaw.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), headingRad);
  const heel = new CANNON.Quaternion();
  heel.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), (heelDeg * Math.PI) / 180);
  yaw.mult(heel, ship.body.quaternion);
  ship.body.angularVelocity.set(0, 0, 0);
}

export { flatWater, waveHeight };
