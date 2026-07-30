/**
 * Core data model.
 *
 * The whole game rests on one idea: a ship is a `Map` from grid coordinate to
 * block type, and every stat — mass, buoyancy, balance, capsize tolerance,
 * whether it can dive — is *derived* from that map. There is no separate
 * "ship health" or "ship class" record to keep in sync. Buoyancy is the
 * health system.
 */

import type * as CANNON from 'cannon';
import type * as THREE from 'three';

// ─── Blocks ──────────────────────────────────────────────────────────────

export const BLOCK_TYPES = [
  'hull',
  'armor',
  'engine',
  'ballast',
  'cannon',
  'light',
  'torpedo',
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export interface BlockDef {
  /** Kilograms. Fights `lift`; the tension between the two is the game. */
  mass: number;
  /** Upward force at full submersion. */
  lift: number;
  /** Damage this block absorbs before it is spliced out of the hull. */
  hp: number;
  /** Hex, as Three.js wants it. */
  color: number;
  label: string;
}

export function isBlockType(v: unknown): v is BlockType {
  return typeof v === 'string' && (BLOCK_TYPES as readonly string[]).includes(v);
}

// ─── Design ──────────────────────────────────────────────────────────────

/** `"ix,iy,iz"` — integer grid coordinates, not world units. */
export type DesignKey = string;

export type Design = Map<DesignKey, BlockType>;

export type GridCoord = readonly [x: number, y: number, z: number];

/**
 * Everything `designStats` derives from a design alone. Pure function of the
 * map — no physics body required, which is what makes the shipyard's live
 * report and the campaign's difficulty estimation share one code path.
 */
export interface DesignStats {
  mass: number;
  lift: number;
  engines: number;
  cannons: number;
  ballast: number;
  count: number;
  torps: number;
  lights: number;
  /** `lift / (mass * G)`. Above ~1.05 the hull floats. */
  liftRatio: number;
  /** Fraction of lift the ballast tanks can cancel, capped at 0.9. */
  ballastCut: number;
  /** Mass centroid minus lift centroid, athwartships. Positive = heavy to starboard. */
  offX: number;
  /** Mass centroid minus lift centroid, fore-and-aft. Positive = heavy toward the bow. */
  offZ: number;
  /** Tall and narrow scores high. */
  capsizeRisk: number;
  /** Lift-weighted beam — how wide the buoyant base is. */
  spreadX: number;
  spreadZ: number;
  /** Degrees of heel tolerated before water starts coming in. */
  capsizeAngle: number;
  /** False if any block is floating free of the main structure. */
  connected: boolean;
  connectedSet: Set<DesignKey>;
  orphans: number;
  floats: boolean;
  canDive: boolean;
}

// ─── Compiled ship ───────────────────────────────────────────────────────

/**
 * One block as it exists in a *compiled* ship: a shape inside the compound
 * body, its own hit points, and its own two buoyancy sample points.
 */
export interface ShipBlock {
  type: BlockType;
  shape: CANNON.Shape;
  alive: boolean;
  hp: number;
  maxHp: number;
  mass: number;
  lift: number;
  /** Offset within the compound body, relative to the centre of mass. */
  local: CANNON.Vec3;
  /** Lower buoyancy sample point. */
  s1: CANNON.Vec3;
  /** Upper buoyancy sample point. */
  s2: CANNON.Vec3;
  isCannon: boolean;
  isLight: boolean;
  isTorpedo: boolean;
}

/**
 * The visual half of a block. Split out from {@link ShipBlock} so the physics
 * side can be built and stepped in Node with no renderer — see
 * `ship/compiler.ts` (pure) versus `ship/view.ts` (Three.js).
 */
export interface ShipBlockView {
  mesh: THREE.Object3D;
  light?: THREE.PointLight | undefined;
  halo?: THREE.Sprite | undefined;
}

export interface TrimCommand {
  /** +1 bow up, -1 bow down. */
  pitch: number;
  /** +1 roll to port, -1 to starboard. */
  roll: number;
  /** 0..1 — dive planes need water over them before they bite. */
  auth: number;
}

export interface Spawn {
  x: number;
  z: number;
  heading: number;
}

/**
 * Bookkeeping the AI carries on a shell so it can watch where its own splash
 * lands and correct the next shot.
 */
export interface ShotSpotting {
  shooter: Ship;
  from: { x: number; y: number; z: number };
  /** Range the shooter was trying to hit. */
  wanted: number;
}

export interface Ship {
  body: CANNON.Body;
  blocks: ShipBlock[];
  /** Stats at compile time. Live values live on the ship itself — see `recountShip`. */
  stats: DesignStats;
  isPlayer: boolean;
  alive: boolean;
  spawn: Spawn;

  initialBlocks: number;
  initialMass: number;

  // ── live counts, recomputed by recountShip as blocks are lost ──
  liveCount: number;
  liveLift: number;
  liveMass: number;
  engines: number;
  cannons: number;
  torpedoes: number;
  lights: number;
  ballastTanks: number;
  ballastCut: number;
  /** Could this hull float again with the tanks blown? */
  buoyant: boolean;

  // ── depth & attitude ──
  /** 0..1 tank fill. */
  ballast: number;
  buoyMul: number;
  flooding: number;
  tiltDeg: number;
  capsizeAngle: number;
  targetDepth: number;
  autoDepth: boolean;
  trimCmd: TrimCommand;

  // ── weapons ──
  reload: number;
  reloadMax: number;
  torpReload: number;
  torpReloadMax: number;

  // ── transient per-frame / AI scratch ──
  /** Seconds spent doomed *and* properly under, before we call it sunk. */
  sinkTimer: number;
  /** Running correction the AI applies to its firing solution. */
  aimBias: number;
  /** Cached min/max gun range, refreshed a few times a second. */
  band?: RangeBand | undefined;
  rangeTimer: number;
}

export interface RangeBand {
  min: number;
  max: number;
}
