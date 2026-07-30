/**
 * The engine → UI bridge.
 *
 * One mutable object, written in place by the engine every frame and read by
 * whatever is drawing the HUD. No allocation, no events, no subscriptions on
 * the hot path.
 *
 * **This is deliberately not React state.** In Phase 3 the React HUD renders
 * its structure once and binds these numbers through refs with change
 * detection, so a battle causes zero re-renders. Discrete state that genuinely
 * should re-render — mode changes, game over, unlocks — goes through the store
 * instead, and that fires a handful of times per battle rather than 60 times a
 * second.
 *
 * Everything here is a primitive on purpose: refs can diff a number cheaply.
 */

export type ReloadState = 'ready' | 'reloading' | 'too-deep' | 'destroyed';
export type TorpedoState = 'ready' | 'reloading' | 'too-shallow' | 'none';
export type PlaneState = 'idle' | 'active' | 'no-flow';

export interface Telemetry {
  // ── hull ──
  /** Percentage of original blocks still attached. */
  hullPct: number;
  buoyant: boolean;
  alive: boolean;

  // ── depth & tanks ──
  /** Metres below the still-water line. */
  depth: number;
  orderedDepth: number;
  hasTanks: boolean;
  /** 0..1 tank fill. */
  ballast: number;
  autoDepth: boolean;
  submarine: boolean;

  // ── damage control ──
  /** 0..1 */
  flooding: number;
  floodCritical: boolean;
  /** True once heel is past the limit and water is coming in. */
  overLimit: boolean;
  /** Engines double as pumps; losing them makes flooding one-way. */
  pumpsDead: boolean;

  // ── attitude ──
  pitchDeg: number;
  rollDeg: number;
  heelDeg: number;
  capsizeAngle: number;
  planeState: PlaneState;
  /** Which way the planes are commanded, for the readout. */
  planeLabel: string;
  /** 0..1 authority — the planes need water over them to bite. */
  planeAuth: number;

  // ── weapons ──
  reloadState: ReloadState;
  /** 0..1 progress; 1 means loaded. */
  reloadPct: number;
  torpedoState: TorpedoState;
  torpedoPct: number;
  hasTorpedoes: boolean;

  // ── aiming ──
  powerPct: number;
  elevDeg: number;
  travDeg: number;
  /** Predicted range in metres, or null when there is no solution. */
  range: number | null;

  // ── enemy ──
  enemyHullPct: number;
}

export const telemetry: Telemetry = {
  hullPct: 100,
  buoyant: true,
  alive: true,

  depth: 0,
  orderedDepth: 0,
  hasTanks: false,
  ballast: 0,
  autoDepth: true,
  submarine: false,

  flooding: 0,
  floodCritical: false,
  overLimit: false,
  pumpsDead: false,

  pitchDeg: 0,
  rollDeg: 0,
  heelDeg: 0,
  capsizeAngle: 40,
  planeState: 'idle',
  planeLabel: 'Planes idle',
  planeAuth: 0,

  reloadState: 'ready',
  reloadPct: 1,
  torpedoState: 'none',
  torpedoPct: 1,
  hasTorpedoes: false,

  powerPct: 50,
  elevDeg: 10,
  travDeg: 0,
  range: null,

  enemyHullPct: 100,
};

/** Restore defaults when leaving battle, so stale readings never linger. */
export function resetTelemetry(): void {
  telemetry.hullPct = 100;
  telemetry.buoyant = true;
  telemetry.alive = true;
  telemetry.depth = 0;
  telemetry.orderedDepth = 0;
  telemetry.hasTanks = false;
  telemetry.ballast = 0;
  telemetry.autoDepth = true;
  telemetry.submarine = false;
  telemetry.flooding = 0;
  telemetry.floodCritical = false;
  telemetry.overLimit = false;
  telemetry.pumpsDead = false;
  telemetry.pitchDeg = 0;
  telemetry.rollDeg = 0;
  telemetry.heelDeg = 0;
  telemetry.planeState = 'idle';
  telemetry.planeLabel = 'Planes idle';
  telemetry.planeAuth = 0;
  telemetry.reloadState = 'ready';
  telemetry.reloadPct = 1;
  telemetry.torpedoState = 'none';
  telemetry.torpedoPct = 1;
  telemetry.hasTorpedoes = false;
  telemetry.range = null;
  telemetry.enemyHullPct = 100;
}
