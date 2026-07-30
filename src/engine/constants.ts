/**
 * Every gameplay number lives here. Single source of truth.
 *
 * This is what made rapid iteration on the prototype possible — a request
 * like "faster reload" was always a one-line change. Keep it that way: when
 * behaviour needs to change, change a constant here, not logic downstream.
 *
 * Values are transcribed verbatim from `legacy/hull-and-havoc-v3.html`. They
 * were tuned empirically, several of them verified numerically (the depth-hold
 * gains, the flood/pump timers, the AI aim convergence). Do not "clean them
 * up" into rounder numbers.
 */

import type { BlockDef, BlockType } from './types';

// ─── World ───────────────────────────────────────────────────────────────

export const WATER_LEVEL = 0;
export const G = 9.82;
export const SEABED = -150;
/** Pitch black at or below this depth. */
export const DARK_DEPTH = 95;

/** Block edge length in world units, and its half. */
export const B = 1.6;
export const HB = B / 2;

// ─── Hull dynamics ───────────────────────────────────────────────────────

export const LINEAR_DAMP = 0.45;
export const ANGULAR_DAMP = 0.8;
/** Vertical drag coefficient, per wet sample point. */
export const VERT_DRAG = 50;

// ─── Propulsion ──────────────────────────────────────────────────────────

/** Per engine block. */
export const ENGINE_THRUST = 1800;
export const TURN_PER_ENGINE = 950;

// ─── Depth control ───────────────────────────────────────────────────────

export const BALLAST_RATE = 0.7;
export const MANUAL_BALLAST_RATE = 0.5;
/** Metres of ordered depth per second of holding dive/rise. */
export const DEPTH_STEP = 11;
export const DEPTH_MAX = 130;

/**
 * Depth-hold controller gains. P on depth error, D on vertical velocity.
 * Tuned to reach ~90% of a step change in ~11s with no overshoot — there is
 * a regression test pinning exactly that, so retune deliberately or not at all.
 */
export const DEPTH_HOLD_P = 0.13;
export const DEPTH_HOLD_D = 0.46;
export const DEPTH_HOLD_CMD_CLAMP = 1.5;
export const DEPTH_HOLD_BALLAST_RATE = 1.9;

/** How fast tanks blow when surfacing or when the ship has no tanks at all. */
export const SURFACE_BLOW_RATE = 0.9;
/** Below this ordered depth, and this actual depth, just blow everything. */
export const SURFACE_ORDER_EPS = 0.4;
export const SURFACE_DEPTH_EPS = 1.2;

/**
 * Depth at which the dive planes have full authority. Above it they scale
 * down linearly — there is no grip until there is real water over them.
 */
export const TRIM_AUTH_DEPTH = 1.6;
/** Below this authority the planes do nothing at all. */
export const TRIM_AUTH_MIN = 0.02;

/** Bow up/down — the trim axis you actually steer a submarine with. */
export const TRIM_PITCH_TORQUE = 4700;
export const TRIM_ROLL_TORQUE = 2200;

// ─── Weapons ─────────────────────────────────────────────────────────────

export const SHELL_SPEED_MIN = 34;
export const SHELL_SPEED_MAX = 115;
export const RELOAD_SURFACE = 1.0;
export const RELOAD_SUB = 1.8;
/** Guns need to be at or near the surface to fire. */
export const CANNON_MAX_DEPTH = 2.2;

export const SHELL_DAMAGE = 165;
export const SPLASH_DAMAGE = 70;
export const SPLASH_RADIUS = 2.6;

// ─── Aiming ──────────────────────────────────────────────────────────────

export const ELEV_MIN = 0;
export const ELEV_MAX = (42 * Math.PI) / 180;
export const TRAV_LIMIT = (34 * Math.PI) / 180;
/** The AI holds a fixed elevation and solves for power instead. */
export const AI_ELEV = (12 * Math.PI) / 180;

/**
 * Shells fall faster than gravity alone. Not physically honest, but it keeps
 * engagement ranges short enough to read on screen. The reticle, the shell and
 * the AI's solver all share this number — that is what makes the reticle
 * land exactly where the shot does.
 */
export const SHELL_GRAVITY_SCALE = 1.3;
/** Ballistics are integrated at a fixed 60 Hz, independent of frame rate. */
export const BALLISTIC_STEP = 1 / 60;
/** Give up after 10 s of flight. */
export const BALLISTIC_MAX_STEPS = 600;

/** Power search bounds used by the AI's range solver. */
export const POWER_MIN = 0.08;
export const POWER_MAX = 1.0;
export const POWER_SEARCH_STEP = 0.03;

export const TORP_SPEED = 24;
export const TORP_DAMAGE = 430;
export const TORP_RELOAD = 4.5;
export const TORP_LIFE = 14;
/** Must be properly under before a tube will launch. */
export const TORP_MIN_DEPTH = 3.0;

// ─── Water ingress / capsizing ───────────────────────────────────────────
// Tilt past the stability limit lets water in. Flooding costs buoyancy,
// which makes the hull list further — an intentional death spiral,
// recoverable only by levelling out, and only while the engines (which
// double as pumps) survive.

/** Flood fraction per second right at the limit. */
export const INGRESS_BASE = 0.07;
/** Additional flood rate per degree past the limit. */
export const INGRESS_PER_DEG = 0.011;
/** Drained per second while upright. Requires at least one live engine. */
export const PUMP_RATE = 0.075;
/** How much buoyancy a full flood costs. */
export const FLOOD_LIFT_LOSS = 0.85;

// ─── Build grid ──────────────────────────────────────────────────────────

export const GRID_R = 5;
export const GRID_H = 5;

// ─── Rendering budget ────────────────────────────────────────────────────

/** Real PointLights are expensive; lamps beyond this are cosmetic only. */
export const MAX_LIVE_LIGHTS = 8;

// ─── Block catalogue ─────────────────────────────────────────────────────
// Gameplay is the tension between mass and lift; hp is how much punishment
// a block takes before it is spliced out of the hull.

export const BLOCKS: Record<BlockType, BlockDef> = {
  hull: { mass: 80, lift: 1600, hp: 100, color: 0x5a6b7c, label: 'Hull' },
  armor: { mass: 200, lift: 700, hp: 340, color: 0x3a4048, label: 'Armor' },
  engine: { mass: 130, lift: 900, hp: 120, color: 0xc8612f, label: 'Engine' },
  ballast: { mass: 110, lift: 1450, hp: 110, color: 0x6a4cc8, label: 'Ballast' },
  cannon: { mass: 140, lift: 800, hp: 150, color: 0x23262b, label: 'Cannon' },
  light: { mass: 60, lift: 780, hp: 70, color: 0xf0dfa0, label: 'Light' },
  torpedo: { mass: 165, lift: 900, hp: 140, color: 0x2f6f5f, label: 'Torpedo' },
};

// ─── Upgradeable tuning ──────────────────────────────────────────────────
// Phase 4 replaces this with `deriveTuning(TUNING, ownedUpgrades)`. Until
// then it stays a single mutable knob with an explicit setter, so nothing
// reaches in and reassigns an imported binding.

let stabilityUpgrade = 0;

/** Degrees added to every ship's capsize angle by purchased upgrades. */
export function getStabilityUpgrade(): number {
  return stabilityUpgrade;
}

export function setStabilityUpgrade(deg: number): void {
  stabilityUpgrade = deg;
}
