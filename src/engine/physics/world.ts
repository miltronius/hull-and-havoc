/**
 * The physics world: one `CANNON.World` and a static seabed plane.
 *
 * No renderer, no DOM — this module is importable from Node, which is what
 * lets the physics regression tests step a real ship with no browser.
 *
 * The seabed collider is not scenery. Before it existed, a ship that could no
 * longer float (mid-ballast-change, say) fell forever, and "you sank" fired on
 * a temporary dip. The floor plus a sink timer fixed both.
 */

import * as CANNON from 'cannon-es';

import { G, SEABED } from '../constants';

export interface PhysicsWorld {
  world: CANNON.World;
  floorBody: CANNON.Body;
}

export function createPhysicsWorld(): PhysicsWorld {
  // `World.solver` is typed as the abstract `Solver`, which has no
  // `iterations`. Build the GSSolver here and configure it while it is still
  // concretely typed, rather than casting after the fact.
  //
  // Two ships plus projectiles never needed more than this. Resist the urge
  // to raise the iteration count without a measured reason.
  const solver = new CANNON.GSSolver();
  solver.iterations = 12;

  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -G, 0),
    broadphase: new CANNON.NaiveBroadphase(),
    solver,
  });

  const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  floorBody.position.set(0, SEABED, 0);
  world.addBody(floorBody);

  return { world, floorBody };
}

/**
 * Fixed timestep, matching the prototype. cannon-es keeps cannon 0.6.2's
 * signature here — `step(fixedTimeStep, timeSinceLastCall, maxSubSteps)`,
 * three arguments in that order — so this call is unchanged by the migration.
 */
export const FIXED_STEP = 1 / 60;
export const MAX_SUB_STEPS = 3;

export function stepWorld(world: CANNON.World, dt: number): void {
  world.step(FIXED_STEP, dt, MAX_SUB_STEPS);
}
