/**
 * Headless physics regressions.
 *
 * Every test in this file pins a behaviour that was originally found the hard
 * way during the prototype — by eye, or by a throwaway Node snippet that was
 * then thrown away. None of them could be written against the single-file
 * build, because `compileShip` allocated Three.js meshes and there was no way
 * to step a ship without a browser. Splitting `buildShip` (pure) from
 * `attachShipView` (Three.js) is what makes them possible.
 *
 * Baselines were measured, not guessed. Where a number is tight (the yaw
 * drift is exactly zero) that is a real invariant, not luck.
 */

import * as CANNON from 'cannon';
import { describe, expect, it } from 'vitest';

import {
  INGRESS_BASE,
  INGRESS_PER_DEG,
  PUMP_RATE,
  SEABED,
} from '../src/engine/constants';
import { createPhysicsWorld, stepWorld } from '../src/engine/physics/world';
import { applyBuoyancy, updateFlooding } from '../src/engine/ship/buoyancy';
import { buildShip, destroyBlock, recountShip } from '../src/engine/ship/compiler';
import { starterDesign } from '../src/engine/ship/design';
import { applyTrim, updateDepthControl } from '../src/engine/ship/helm';
import type { Ship } from '../src/engine/types';
import {
  heading,
  headingDeltaDeg,
  rig,
  run,
  setAttitude,
  spread,
  STEP,
  symmetricDiverDesign,
  topHeavyDesign,
} from './helpers/sim';

describe('flotation', () => {
  it('the starter ship settles to a steady waterline and stays there', () => {
    const r = rig(starterDesign());
    run(r, 20); // let it settle

    const ys: number[] = [];
    run(r, 10, {}, (x) => ys.push(x.ship.body.position.y));

    // Measured: -0.1697, and it does not move afterwards.
    expect(r.ship.body.position.y).toBeCloseTo(-0.17, 2);
    expect(spread(ys).range).toBeLessThan(0.01);
    expect(r.ship.flooding).toBe(0);
    expect(r.ship.buoyant).toBe(true);
    expect(r.ship.alive).toBe(true);
  });

  it('a hull that cannot float sinks, and the seabed catches it', () => {
    const r = rig(topHeavyDesign());
    run(r, 60);
    // It must end up on the bottom, not falling forever. Before the seabed
    // collider existed, an unfloatable ship fell to unbounded depth.
    expect(r.ship.body.position.y).toBeLessThan(-100);
    expect(r.ship.body.position.y).toBeGreaterThan(SEABED);
    expect(r.ship.buoyant).toBe(false);
  });
});

describe('depth-hold controller', () => {
  /**
   * CLAUDE.md records the P+D gains as tuned to reach ~90% of a step change in
   * roughly ten seconds with no overshoot. That was verified numerically once
   * and then lived only in a comment. Now it is enforced.
   */
  it('reaches 90% of a 20 m step in under 12 s without overshooting', () => {
    const r = rig(symmetricDiverDesign());
    run(r, 15);
    run(r, 30, () => (r.ship.targetDepth < 20 ? { depth: 1 } : { depth: 0 }));

    const start = -r.ship.body.position.y;
    const target = 40;
    r.ship.targetDepth = target;

    const t0 = r.t;
    let t90 = -1;
    let peak = start;
    run(r, 40, {}, (x) => {
      const d = -x.ship.body.position.y;
      peak = Math.max(peak, d);
      if (t90 < 0 && d >= start + 0.9 * (target - start)) t90 = x.t - t0;
    });

    // Measured: t90 = 8.58 s, peak 40.003 m, final 40.000 m.
    expect(t90).toBeGreaterThan(4);
    expect(t90).toBeLessThan(12);
    // "No overshoot" — a few millimetres is the solver, not a wobble.
    expect(peak - target).toBeLessThan(0.5);
    expect(-r.ship.body.position.y).toBeCloseTo(target, 1);
  });

  it('holds ordered depth rather than drifting off it', () => {
    const r = rig(symmetricDiverDesign());
    run(r, 15);
    run(r, 45, () => (r.ship.targetDepth < 30 ? { depth: 1 } : { depth: 0 }));

    const ds: number[] = [];
    run(r, 30, {}, (x) => ds.push(-x.ship.body.position.y));
    expect(spread(ds).range).toBeLessThan(0.5);
    expect(-r.ship.body.position.y).toBeCloseTo(30, 0);
  });

  it('a ship with no tanks blows them and stays on the surface', () => {
    const r = rig(starterDesign());
    // Strip the tanks the way battle damage would.
    for (const b of r.ship.blocks) if (b.type === 'ballast') b.alive = false;
    recountShip(r.ship);
    r.ship.ballast = 1;

    run(r, 20, { depth: 1 }); // hold "dive" — it must be ignored
    expect(r.ship.ballastTanks).toBe(0);
    expect(r.ship.ballast).toBe(0);
    expect(r.ship.targetDepth).toBe(0);
    expect(-r.ship.body.position.y).toBeLessThan(1);
  });
});

describe('rotation invariants', () => {
  /**
   * The phantom-yaw regression.
   *
   * Drag must be applied once at the centre of mass. Applying it at each
   * off-centre buoyancy sample point sums into a torque that slowly spins the
   * hull. On the surface it is invisible — waves average it out as sample
   * points enter and leave the water — but it becomes a constant yaw the
   * moment the boat is fully submerged and every point is wet at once.
   *
   * For a symmetric hull the correct answer is exactly zero, which makes this
   * a very sharp test: reintroduce per-point drag and it fails immediately.
   */
  it('a submerged, level, unforced hull does not yaw', () => {
    const r = rig(symmetricDiverDesign());
    run(r, 15);
    run(r, 45, () => (r.ship.targetDepth < 40 ? { depth: 1 } : { depth: 0 }));

    expect(-r.ship.body.position.y).toBeGreaterThan(35); // genuinely under
    expect(r.ship.tiltDeg).toBeLessThan(0.5); // genuinely level

    const before = heading(r.ship);
    run(r, 30, {});

    expect(Math.abs(headingDeltaDeg(before, heading(r.ship)))).toBeLessThan(0.05);
    expect(Math.abs(r.ship.body.angularVelocity.y)).toBeLessThan(1e-4);
  });

  /**
   * The trim-isolation regression.
   *
   * Horizontal torque axes are not independent once a hull is tilted: a
   * tilted "right" axis has a vertical component, so pitch input applied
   * along the body's *local* axes bled into yaw and the boat quietly wandered
   * off course. `applyTrim` writes only `torque.x` and `torque.z`, which
   * strips the vertical component out.
   *
   * This is asserted on the torque directly rather than by integrating a
   * heading over time. At depth the planes have full authority, so ten
   * seconds of pitch input tumbles the hull bow-over-stern — correct physics,
   * but it makes `atan2`-based heading meaningless past 90° of pitch. The
   * torque is the invariant; the heading was only ever a proxy for it.
   */
  const attitudes: Array<[heel: number, heading: number]> = [
    [0, 0],
    [20, 0],
    [35, 0],
    [20, Math.PI / 3],
    [45, -Math.PI / 4],
    [60, 2.1],
  ];

  it.each(attitudes)('trim contributes no yaw torque at %i° heel, heading %f', (heel, hdg) => {
    const r = rig(symmetricDiverDesign());
    run(r, 15);
    run(r, 45, () => (r.ship.targetDepth < 40 ? { depth: 1 } : { depth: 0 }));
    setAttitude(r.ship, heel, hdg);

    for (const [pitch, roll] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, -1],
    ]) {
      r.ship.body.torque.set(0, 0, 0);
      applyTrim(r.ship, pitch!, roll!);
      expect(r.ship.body.torque.y).toBe(0);
      // ...and it must actually be doing something, or the test is vacuous.
      expect(Math.hypot(r.ship.body.torque.x, r.ship.body.torque.z)).toBeGreaterThan(0);
    }
  });

  it('the naive local-axis formulation would bleed into yaw — the guard is real', () => {
    // Demonstrates what `applyTrim` is protecting against. Applying pitch
    // torque along the body's own right axis puts a vertical component into
    // the torque the moment the hull is not level.
    const r = rig(symmetricDiverDesign());
    setAttitude(r.ship, 35, 0);

    const right = new CANNON.Vec3();
    r.ship.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0), right);

    // A tilted "right" axis is not horizontal.
    expect(Math.abs(right.y)).toBeGreaterThan(0.5);
    // Which is exactly the component applyTrim declines to apply.
    r.ship.body.torque.set(0, 0, 0);
    applyTrim(r.ship, 1, 0);
    expect(r.ship.body.torque.y).toBe(0);
  });

  it('adds no yaw torque on any frame of a live dive, at any attitude', () => {
    // The dynamic counterpart to the test above. Note that this asserts on
    // the torque, not on a heading: pitching a *heeled* hull swings its nose
    // through a cone, so the horizontal projection of the forward axis
    // genuinely rotates even when nothing is yawing. Heading was always a
    // proxy; the torque is the invariant.
    const r = rig(symmetricDiverDesign());
    run(r, 15);

    let frames = 0;
    for (let i = 0; i < 60 * 20; i++) {
      // Vary the input so pitch, roll and both-together are all exercised
      // while the hull tumbles through a wide range of real attitudes.
      const phase = Math.floor(i / 120) % 4;
      const pitch = phase === 0 || phase === 3 ? 1 : phase === 1 ? -1 : 0;
      const roll = phase === 2 || phase === 3 ? 1 : 0;

      updateDepthControl(r.ship, STEP, r.ship.targetDepth < 40 ? 1 : 0);
      r.ship.body.torque.set(0, 0, 0);
      applyTrim(r.ship, pitch, roll);
      // Checked here, before buoyancy — off-centre lift legitimately produces
      // torque about every axis, and that is not what we are policing.
      expect(r.ship.body.torque.y).toBe(0);
      frames++;

      updateFlooding(r.ship, STEP);
      applyBuoyancy(r.ship, r.t, r.waves);
      stepWorld(r.world, STEP);
      r.t += STEP;
    }

    expect(frames).toBe(1200);
    // The hull really did move around — otherwise this proves nothing.
    expect(r.ship.tiltDeg).toBeGreaterThan(1);
  });

  it('dive planes have no authority at the surface', () => {
    const r = rig(symmetricDiverDesign());
    run(r, 15);
    expect(-r.ship.body.position.y).toBeLessThan(1.6);

    run(r, 5, { pitch: 1 });
    // trimCmd records the input, but authority is ~zero with no water over
    // the planes, so the hull should barely move.
    expect(r.ship.trimCmd.pitch).toBe(1);
    expect(r.ship.trimCmd.auth).toBeLessThan(0.35);
    expect(r.ship.tiltDeg).toBeLessThan(10);
  });
});

describe('water ingress and pumps', () => {
  function floodRig(): Ship {
    const { world } = createPhysicsWorld();
    return buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
  }

  it('does not ship water while inside the stability limit', () => {
    const ship = floodRig();
    setAttitude(ship, ship.capsizeAngle - 5);
    const res = updateFlooding(ship, 1);
    expect(res.takingWater).toBe(false);
    expect(ship.flooding).toBe(0);
  });

  it('floods at the documented rate once past the limit', () => {
    const ship = floodRig();
    const over = 10;
    setAttitude(ship, ship.capsizeAngle + over);

    const res = updateFlooding(ship, 1);
    expect(res.takingWater).toBe(true);
    // base rate, plus a linear penalty per degree past the limit
    expect(ship.flooding).toBeCloseTo(INGRESS_BASE + over * INGRESS_PER_DEG, 6);
    expect(res.tiltDeg).toBeCloseTo(ship.capsizeAngle + over, 4);
  });

  it('floods faster the further past the limit it heels', () => {
    const mild = floodRig();
    setAttitude(mild, mild.capsizeAngle + 2);
    updateFlooding(mild, 1);

    const severe = floodRig();
    setAttitude(severe, severe.capsizeAngle + 25);
    updateFlooding(severe, 1);

    expect(severe.flooding).toBeGreaterThan(mild.flooding);
  });

  it('never floods beyond fully swamped', () => {
    const ship = floodRig();
    setAttitude(ship, ship.capsizeAngle + 40);
    updateFlooding(ship, 60);
    expect(ship.flooding).toBe(1);
  });

  it('pumps out at the documented rate when upright, while engines live', () => {
    const ship = floodRig();
    ship.flooding = 0.5;
    setAttitude(ship, 0);
    expect(ship.engines).toBeGreaterThan(0);

    updateFlooding(ship, 1);
    expect(ship.flooding).toBeCloseTo(0.5 - PUMP_RATE, 6);
  });

  it('cannot pump with the engines destroyed — the death spiral is one-way', () => {
    const ship = floodRig();
    ship.flooding = 0.5;
    setAttitude(ship, 0);

    for (const b of ship.blocks) if (b.type === 'engine') destroyBlock(ship, b);
    expect(ship.engines).toBe(0);

    updateFlooding(ship, 5);
    expect(ship.flooding).toBe(0.5); // not a drop drained
  });

  it('flooding costs buoyancy, and enough of it sinks the ship', () => {
    const ship = floodRig();
    expect(ship.buoyant).toBe(true);

    ship.flooding = 1;
    recountShip(ship);
    expect(ship.buoyant).toBe(false);
  });
});

describe('destroyBlock', () => {
  it('keeps the compound body internally consistent', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
    const initial = ship.blocks.length;
    expect(ship.body.shapes.length).toBe(initial);

    let removed = 0;
    for (const blk of [...ship.blocks]) {
      const at = destroyBlock(ship, blk);
      removed++;
      expect(at).not.toBeNull();

      // The three parallel arrays must stay in lockstep — cannon 0.6.2 has no
      // removeShape(), so they are spliced by hand.
      const n = initial - removed;
      expect(ship.body.shapes.length).toBe(n);
      expect(ship.body.shapeOffsets.length).toBe(n);
      expect(ship.body.shapeOrientations.length).toBe(n);
      expect(ship.liveCount).toBe(n);
      // A zero-mass body would silently become static mid-battle.
      expect(ship.body.mass).toBeGreaterThanOrEqual(40);
      expect(Number.isFinite(ship.body.mass)).toBe(true);
    }

    expect(ship.liveCount).toBe(0);
    expect(ship.buoyant).toBe(false);
  });

  it('is idempotent — destroying a dead block changes nothing', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
    const blk = ship.blocks[0]!;

    expect(destroyBlock(ship, blk)).not.toBeNull();
    const shapes = ship.body.shapes.length;
    const mass = ship.body.mass;
    const live = ship.liveCount;

    expect(destroyBlock(ship, blk)).toBeNull();
    expect(ship.body.shapes.length).toBe(shapes);
    expect(ship.body.mass).toBe(mass);
    expect(ship.liveCount).toBe(live);
  });

  it('reports where the block was, in world space, for debris', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 40, z: -25, heading: 0 }, true);
    const at = destroyBlock(ship, ship.blocks[0]!);

    expect(at).not.toBeNull();
    // Near the hull, not at the world origin.
    expect(Math.hypot(at!.x - 40, at!.z + 25)).toBeLessThan(10);
  });

  it('losing engines removes both propulsion and pumps', () => {
    const { world } = createPhysicsWorld();
    const ship = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
    expect(ship.engines).toBe(1);

    for (const b of [...ship.blocks]) if (b.type === 'engine') destroyBlock(ship, b);
    expect(ship.engines).toBe(0);
    expect(ship.liveCount).toBe(ship.initialBlocks - 1);
  });
});
