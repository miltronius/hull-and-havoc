/**
 * Helm: thrust, steering, depth control and trim.
 *
 * These are the *physics* of control, deliberately separated from reading a
 * keyboard or a joystick. `input/` decides what the player asked for; this
 * module turns that into forces. The separation is what makes the depth-hold
 * controller and the trim axes testable in Node with no browser.
 */

import * as CANNON from 'cannon-es';

import {
  DEPTH_HOLD_BALLAST_RATE,
  DEPTH_HOLD_CMD_CLAMP,
  DEPTH_HOLD_D,
  DEPTH_HOLD_P,
  DEPTH_MAX,
  DEPTH_STEP,
  ENGINE_THRUST,
  MANUAL_BALLAST_RATE,
  SURFACE_BLOW_RATE,
  SURFACE_DEPTH_EPS,
  SURFACE_ORDER_EPS,
  TRIM_AUTH_DEPTH,
  TRIM_AUTH_MIN,
  TRIM_PITCH_TORQUE,
  TRIM_ROLL_TORQUE,
  TURN_PER_ENGINE,
} from '../constants';
import { clamp } from '../math';
import type { Ship } from '../types';
import { shipDepth } from './buoyancy';

const _thrust = new CANNON.Vec3();
const _localFwd = new CANNON.Vec3();
const _right = new CANNON.Vec3();
const _fwdAxis = new CANNON.Vec3();
const _X = new CANNON.Vec3(1, 0, 0);
const _Z = new CANNON.Vec3(0, 0, 1);

/**
 * Engine thrust and rudder.
 *
 * Thrust is applied at the centre of mass, precisely so it does not induce
 * rotation. In cannon-es `applyForce`'s second argument is a point *relative
 * to* the centre of mass and defaults to zero, so omitting it is exactly what
 * we want. (Under cannon 0.6.2 that argument was a *world* point and this call
 * passed `body.position`; passing the origin there instead was an early source
 * of runaway torque.)
 *
 * @param throttle -1..1, positive ahead
 * @param steer    -1..1, positive to starboard
 */
export function applyThrust(ship: Ship, throttle: number, steer: number): void {
  const b = ship.body;
  const thrust = ship.engines * ENGINE_THRUST;

  if (throttle !== 0 && thrust > 0) {
    _localFwd.set(0, 0, thrust * throttle);
    b.quaternion.vmult(_localFwd, _thrust);
    b.applyForce(_thrust);
  }

  // A dead-in-the-water hull still has a rudder, but no engines means no
  // steering authority at all.
  const turn = Math.max(ship.engines, 1) * TURN_PER_ENGINE;
  if (steer !== 0 && ship.engines > 0) {
    // cannon-es does have applyTorque(), but accumulating directly stays
    // allocation-free on the hot path and matches applyTrim below, which has
    // to write individual components anyway. The solver clears body.torque
    // each step either way.
    b.torque.y += -steer * turn;
  }
}

/**
 * Ballast and ordered depth.
 *
 * In auto mode a P+D controller trims the tanks to hold `targetDepth`:
 * proportional on depth error, derivative on vertical velocity. The gains are
 * tuned to reach ~90% of a step change in about 11 seconds with no overshoot,
 * and `tests/physics.test.ts` pins that. In manual mode the player floods and
 * blows the tanks directly.
 *
 * @param want +1 to go deeper, -1 to come up, 0 to hold
 */
export function updateDepthControl(ship: Ship, dt: number, want: number): void {
  const b = ship.body;
  const depthNow = shipDepth(ship);

  if (ship.ballastTanks === 0) {
    // No tanks: there is nothing to order and nothing to hold.
    ship.targetDepth = 0;
    ship.ballast = Math.max(0, ship.ballast - dt * SURFACE_BLOW_RATE);
    return;
  }

  if (ship.autoDepth) {
    ship.targetDepth = clamp(ship.targetDepth + want * DEPTH_STEP * dt, 0, DEPTH_MAX);
    if (ship.targetDepth < SURFACE_ORDER_EPS && depthNow < SURFACE_DEPTH_EPS) {
      // Ordered to the surface and effectively there — blow everything rather
      // than letting the controller hunt around zero.
      ship.ballast = Math.max(0, ship.ballast - dt * SURFACE_BLOW_RATE);
    } else {
      const err = ship.targetDepth - depthNow; // + = go deeper
      const rising = b.velocity.y; // + = coming up
      const cmd = clamp(
        err * DEPTH_HOLD_P + rising * DEPTH_HOLD_D,
        -DEPTH_HOLD_CMD_CLAMP,
        DEPTH_HOLD_CMD_CLAMP,
      );
      ship.ballast = clamp(ship.ballast + cmd * dt * DEPTH_HOLD_BALLAST_RATE, 0, 1);
    }
  } else {
    ship.ballast = clamp(ship.ballast + want * dt * MANUAL_BALLAST_RATE, 0, 1);
    ship.targetDepth = depthNow;
  }
}

/**
 * Stern dive planes.
 *
 * Authority scales with depth — the planes need water over them before they
 * bite. Mutates `ship.trimCmd`, which the view layer reads to deflect the
 * visible fins and the HUD reads to report whether the input is doing
 * anything.
 *
 * The vertical component of the torque is deliberately discarded. Horizontal
 * torque axes are *not* independent once a hull is tilted: a tilted "right"
 * axis has a vertical component, so applying pitch torque along the body's
 * local axes bled into yaw and the boat quietly wandered off course. Writing
 * only `torque.x` and `torque.z` strips that out.
 *
 * @param tPitch +1 bow up, -1 bow down
 * @param tRoll  +1 roll to port, -1 to starboard
 */
export function applyTrim(ship: Ship, tPitch: number, tRoll: number): void {
  const b = ship.body;
  const depthNow = shipDepth(ship);

  ship.trimCmd.pitch = tPitch;
  ship.trimCmd.roll = tRoll;
  ship.trimCmd.auth = 0;

  if (tPitch === 0 && tRoll === 0) return;

  const auth = clamp(depthNow / TRIM_AUTH_DEPTH, 0, 1);
  ship.trimCmd.auth = auth;
  if (auth <= TRIM_AUTH_MIN) return;

  b.quaternion.vmult(_X, _right);
  b.quaternion.vmult(_Z, _fwdAxis);

  const mp = tPitch * TRIM_PITCH_TORQUE * auth;
  const mr = tRoll * TRIM_ROLL_TORQUE * auth;

  b.torque.x += _right.x * mp + _fwdAxis.x * mr;
  b.torque.z += _right.z * mp + _fwdAxis.z * mr;
}
