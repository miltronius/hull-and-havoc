/**
 * What the player is currently asking for.
 *
 * Input handlers write here; `helm.ts` reads it and turns it into forces.
 * Deliberately a plain mutable record rather than events — the simulation
 * samples it once per frame and never needs to replay anything.
 */

export interface AimState {
  /** 0..1 */
  power: number;
  /** Barrel elevation, radians. */
  elev: number;
  /** Barrel traverse, radians. */
  trav: number;
}

export interface OrbitCamera {
  yaw: number;
  pitch: number;
  dist: number;
}

export const CAMERA_LIMITS = {
  minPitch: -0.25,
  maxPitch: 1.35,
  minDist: 8,
  maxDist: 60,
} as const;

export interface InputState {
  /** Keyed by `KeyboardEvent.code`. */
  keys: Record<string, boolean>;
  /** Touch joystick, -1..1 each axis. */
  joyX: number;
  joyY: number;
  /** Held ballast buttons. */
  floodHeld: boolean;
  blowHeld: boolean;
  trimHeld: { up: boolean; down: boolean; left: boolean; right: boolean };
  aim: AimState;
  camera: OrbitCamera;
}

export function createInputState(): InputState {
  return {
    keys: {},
    joyX: 0,
    joyY: 0,
    floodHeld: false,
    blowHeld: false,
    trimHeld: { up: false, down: false, left: false, right: false },
    aim: { power: 0.5, elev: (10 * Math.PI) / 180, trav: 0 },
    camera: { yaw: 0, pitch: 0.28, dist: 24 },
  };
}

/** Resolve throttle/steer from keyboard and joystick together. */
export function readThrottle(input: InputState, isTouch: boolean): number {
  let v = 0;
  if (input.keys['KeyW']) v += 1;
  if (input.keys['KeyS']) v -= 1;
  if (isTouch) v += -input.joyY;
  return v;
}

export function readSteer(input: InputState, isTouch: boolean): number {
  let v = 0;
  if (input.keys['KeyA']) v -= 1;
  if (input.keys['KeyD']) v += 1;
  if (isTouch) v += input.joyX;
  return v;
}

/** +1 to go deeper, -1 to come up. */
export function readDepth(input: InputState): number {
  let v = 0;
  if (input.keys['KeyQ'] || input.floodHeld) v += 1;
  if (input.keys['KeyE'] || input.blowHeld) v -= 1;
  return v;
}

export function readPitchTrim(input: InputState): number {
  let v = 0;
  if (input.keys['KeyI'] || input.trimHeld.up) v += 1;
  if (input.keys['KeyK'] || input.trimHeld.down) v -= 1;
  return v;
}

export function readRollTrim(input: InputState): number {
  let v = 0;
  if (input.keys['KeyJ'] || input.trimHeld.left) v += 1;
  if (input.keys['KeyL'] || input.trimHeld.right) v -= 1;
  return v;
}
