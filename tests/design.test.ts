/**
 * Baseline for the pure design model.
 *
 * These numbers were not written by hand and they were not produced by the
 * code under test. They were extracted by slicing `designStats`, `BLOCKS` and
 * the stock designs verbatim out of `legacy/hull-and-havoc-v3.html` and
 * evaluating them, so this file genuinely pins the *prototype's* behaviour
 * rather than restating the port's.
 *
 * If a change here fails, the question is always "did I mean to change the
 * physics of every ship in the game?" — not "should I update the number?".
 */

import { describe, expect, it } from 'vitest';

import { BLOCKS, G } from '../src/engine/constants';
import {
  connectivity,
  designStats,
  enemyDesign,
  key,
  parseKey,
  starterDesign,
} from '../src/engine/ship/design';

/** Tight enough to catch a real formula change, loose enough for float noise. */
const P = 10;

describe('key / parseKey', () => {
  it('round-trips grid coordinates including negatives', () => {
    expect(key(-1, 0, 2)).toBe('-1,0,2');
    expect(parseKey('-1,0,2')).toEqual([-1, 0, 2]);
    expect(parseKey(key(3, -4, 5))).toEqual([3, -4, 5]);
  });
});

describe('BLOCKS catalogue', () => {
  it('matches the legacy mass/lift/hp values', () => {
    // The mass-vs-lift tension is the whole game; these are load-bearing.
    expect(BLOCKS.hull).toMatchObject({ mass: 80, lift: 1600, hp: 100 });
    expect(BLOCKS.armor).toMatchObject({ mass: 200, lift: 700, hp: 340 });
    expect(BLOCKS.engine).toMatchObject({ mass: 130, lift: 900, hp: 120 });
    expect(BLOCKS.ballast).toMatchObject({ mass: 110, lift: 1450, hp: 110 });
    expect(BLOCKS.cannon).toMatchObject({ mass: 140, lift: 800, hp: 150 });
    expect(BLOCKS.light).toMatchObject({ mass: 60, lift: 780, hp: 70 });
    expect(BLOCKS.torpedo).toMatchObject({ mass: 165, lift: 900, hp: 140 });
  });

  it('uses the legacy gravity constant', () => {
    expect(G).toBe(9.82);
  });
});

describe('designStats — starter ship', () => {
  const s = designStats(starterDesign());

  it('counts blocks and subsystems', () => {
    expect(s.count).toBe(20);
    expect(s.engines).toBe(1);
    expect(s.cannons).toBe(1);
    expect(s.ballast).toBe(1);
    expect(s.torps).toBe(0);
    expect(s.lights).toBe(0);
  });

  it('derives mass and lift', () => {
    expect(s.mass).toBe(1740);
    expect(s.lift).toBe(30350);
    expect(s.liftRatio).toBeCloseTo(1.7762249222, P);
    expect(s.ballastCut).toBeCloseTo(0.25, P);
  });

  it('derives balance and stability', () => {
    expect(s.offX).toBeCloseTo(0, P); // symmetric about the keel
    expect(s.offZ).toBeCloseTo(-0.0649415819, P);
    expect(s.capsizeRisk).toBeCloseTo(0.6609267424, P);
    expect(s.spreadX).toBeCloseTo(0.7260735958, P);
    expect(s.spreadZ).toBeCloseTo(1.4087449428, P);
    expect(s.capsizeAngle).toBeCloseTo(36.8911039374, P);
  });

  it('floats, but cannot dive on one tank', () => {
    expect(s.floats).toBe(true);
    // 1.776 * (1 - 0.25) = 1.332, still well above the 0.95 dive threshold.
    // This is why the stock ship reports "No Dive Capability".
    expect(s.canDive).toBe(false);
    expect(s.connected).toBe(true);
    expect(s.orphans).toBe(0);
  });
});

describe('designStats — enemy ship', () => {
  const s = designStats(enemyDesign());

  it('matches the legacy figures', () => {
    expect(s.count).toBe(24);
    expect(s.mass).toBe(2320);
    expect(s.lift).toBe(34400);
    expect(s.engines).toBe(2);
    expect(s.cannons).toBe(1);
    expect(s.ballast).toBe(0);
    expect(s.liftRatio).toBeCloseTo(1.5099374956, P);
    expect(s.offX).toBeCloseTo(0, P);
    expect(s.offZ).toBeCloseTo(0.1135725742, P);
    expect(s.spreadX).toBeCloseTo(0.781322671, P);
    expect(s.spreadZ).toBeCloseTo(1.7421863537, P);
    expect(s.capsizeAngle).toBeCloseTo(37.7198400656, P);
  });

  it('is a pure surface ship — no tanks, no dive', () => {
    expect(s.ballastCut).toBe(0);
    expect(s.canDive).toBe(false);
    expect(s.floats).toBe(true);
  });
});

describe('designStats — empty design', () => {
  const s = designStats(new Map());

  it('does not divide by zero', () => {
    expect(s.mass).toBe(0);
    expect(s.liftRatio).toBe(0);
    expect(s.spreadX).toBe(0);
    expect(s.capsizeRisk).toBe(0);
    expect(s.offX).toBe(0);
    expect(s.offZ).toBe(0);
  });

  it('does not float and is trivially connected', () => {
    expect(s.floats).toBe(false);
    expect(s.canDive).toBe(false);
    expect(s.connected).toBe(true);
    expect(s.orphans).toBe(0);
    // Base of the capsize formula with no hull to widen it.
    expect(s.capsizeAngle).toBe(26);
  });
});

describe('connectivity', () => {
  it('accepts a solid hull', () => {
    const c = connectivity(starterDesign());
    expect(c.ok).toBe(true);
    expect(c.set.size).toBe(20);
    expect(c.orphans).toBe(0);
  });

  it('rejects a block floating free of the structure', () => {
    const d = starterDesign();
    d.set(key(4, 0, 4), 'hull');
    const c = connectivity(d);
    expect(c.ok).toBe(false);
    expect(c.set.size).toBe(20);
    expect(c.orphans).toBe(1);
  });

  it('requires face contact — corner-touching is not connected', () => {
    const d: ReturnType<typeof starterDesign> = new Map();
    d.set(key(0, 0, 0), 'hull');
    d.set(key(1, 1, 0), 'hull'); // shares an edge, not a face
    expect(connectivity(d).ok).toBe(false);
  });

  it('treats a single block as connected', () => {
    const d: ReturnType<typeof starterDesign> = new Map();
    d.set(key(0, 0, 0), 'hull');
    expect(connectivity(d).ok).toBe(true);
  });

  it('handles the empty design', () => {
    const c = connectivity(new Map());
    expect(c.ok).toBe(true);
    expect(c.orphans).toBe(0);
  });
});
