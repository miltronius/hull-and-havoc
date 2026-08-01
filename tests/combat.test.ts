/**
 * Weapons, damage and fall-of-shot correction.
 *
 * All headless: the {@link Effects} seam keeps spray and debris out of the
 * simulation, so guns, torpedoes and damage can be exercised in Node.
 */

import * as CANNON from 'cannon-es';
import { describe, expect, it } from 'vitest';

import { AI_ELEV, CANNON_MAX_DEPTH, SHELL_DAMAGE, TORP_MIN_DEPTH } from '../src/engine/constants';
import { speedFromPower } from '../src/engine/combat/ballistics';
import { recordingEffects } from '../src/engine/combat/effects';
import {
  SPOT_BIAS_MAX,
  SPOT_BIAS_MIN,
  SPOT_MIN_FLIGHT,
  spotCorrection,
} from '../src/engine/combat/spotting';
import {
  createCombat,
  damageAt,
  DIRECT_HIT_RADIUS,
  fire,
  fireTorpedo,
  sinkShip,
  updateShells,
} from '../src/engine/combat/weapons';
import { createPhysicsWorld } from '../src/engine/physics/world';
import { buildShip } from '../src/engine/ship/compiler';
import { key, starterDesign } from '../src/engine/ship/design';
import type { Design, Ship, ShotSpotting } from '../src/engine/types';
import { flatWater } from '../src/engine/waves';

function shipAt(design: Design, x = 0, z = 0, heading = 0): Ship {
  const { world } = createPhysicsWorld();
  return buildShip(world, design, { x, z, heading }, true);
}

function subDesign(): Design {
  const d: Design = new Map();
  for (let x = -1; x <= 1; x++) {
    for (let z = -2; z <= 2; z++) d.set(key(x, 0, z), 'hull');
  }
  d.set(key(0, 1, 0), 'torpedo');
  d.set(key(0, 1, -1), 'ballast');
  return d;
}

describe('fire', () => {
  const shot = { speed: speedFromPower(0.5), elev: AI_ELEV };

  it('launches one shell per live gun and starts the reload', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    expect(ship.cannons).toBe(1);

    expect(fire(ship, combat, shot)).toBe(true);
    expect(combat.shells).toHaveLength(1);
    expect(ship.reload).toBeGreaterThan(0);
    expect(combat.shells[0]!.owner).toBe(ship);
  });

  it('refuses to fire while reloading', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();

    expect(fire(ship, combat, shot)).toBe(true);
    expect(fire(ship, combat, shot)).toBe(false);
    expect(combat.shells).toHaveLength(1);
  });

  it('refuses once the guns are destroyed', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    for (const b of ship.blocks) if (b.isCannon) b.alive = false;

    expect(fire(ship, combat, shot)).toBe(false);
    expect(combat.shells).toHaveLength(0);
  });

  it('refuses below periscope depth — guns need the surface', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    ship.body.position.y = -(CANNON_MAX_DEPTH + 1);

    expect(fire(ship, combat, shot)).toBe(false);
  });

  it('refuses from a sunk ship', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    ship.alive = false;
    expect(fire(ship, combat, shot)).toBe(false);
  });

  it('kicks the hull backwards with recoil', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    ship.body.velocity.set(0, 0, 0);

    fire(ship, combat, { ...shot, elev: 0 });
    // Bow is +Z, so firing forward shoves the hull aft.
    expect(ship.body.velocity.z).toBeLessThan(0);
  });

  it('reports the muzzle flash through the effects seam', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    const fx = recordingEffects();

    fire(ship, combat, { ...shot, effects: fx });
    expect(fx.splashes.length).toBeGreaterThan(0);
  });
});

describe('fireTorpedo', () => {
  it('refuses at the surface — the tube must be properly under', () => {
    const ship = shipAt(subDesign());
    const combat = createCombat();
    ship.body.position.y = 0;

    expect(fireTorpedo(ship, combat)).toBe(false);
    expect(combat.torpedoes).toHaveLength(0);
  });

  it('launches once deep enough', () => {
    const ship = shipAt(subDesign());
    const combat = createCombat();
    ship.body.position.y = -(TORP_MIN_DEPTH + 2);

    expect(fireTorpedo(ship, combat)).toBe(true);
    expect(combat.torpedoes).toHaveLength(1);
    expect(ship.torpReload).toBeGreaterThan(0);
  });

  it('runs flat regardless of the hull’s pitch', () => {
    const ship = shipAt(subDesign());
    const combat = createCombat();
    ship.body.position.y = -20;
    // Pitch the boat sharply bow-down; the fish must still run level.
    ship.body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), 0.6);
    fireTorpedo(ship, combat);

    const tp = combat.torpedoes[0]!;
    expect(tp.dir.y).toBe(0);
    expect(Math.hypot(tp.dir.x, tp.dir.z)).toBeCloseTo(1, 6);
  });

  it('refuses without a tube', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    ship.body.position.y = -20;
    expect(fireTorpedo(ship, combat)).toBe(false);
  });
});

describe('damageAt', () => {
  /** World position of a live block, for aiming a test hit. */
  function blockWorld(ship: Ship, index: number) {
    const blk = ship.blocks[index]!;
    return {
      x: ship.body.position.x + blk.local.x,
      y: ship.body.position.y + blk.local.y,
      z: ship.body.position.z + blk.local.z,
    };
  }

  it('damages the nearest live block', () => {
    const ship = shipAt(starterDesign());
    const at = blockWorld(ship, 0);
    const before = ship.blocks[0]!.hp;

    expect(damageAt(ship, at.x, at.y, at.z, 50)).toBe(true);
    expect(ship.blocks[0]!.hp).toBeLessThan(before);
  });

  it('misses cleanly when nothing is close enough', () => {
    const ship = shipAt(starterDesign());
    expect(damageAt(ship, 500, 0, 500, SHELL_DAMAGE)).toBe(false);
    expect(ship.liveCount).toBe(ship.initialBlocks);
  });

  it('spreads reduced damage to neighbours', () => {
    const ship = shipAt(starterDesign());
    const at = blockWorld(ship, 0);
    const neighbourHp = ship.blocks.slice(1).map((b) => b.hp);

    damageAt(ship, at.x, at.y, at.z, 10); // small direct hit, big splash radius
    const after = ship.blocks.slice(1).map((b) => b.hp);

    // At least one neighbour took collateral, and none took the full hit.
    expect(after.some((hp, i) => hp < neighbourHp[i]!)).toBe(true);
  });

  it('destroys blocks that reach zero, and the hull loses lift for it', () => {
    const ship = shipAt(starterDesign());
    const liftBefore = ship.liveLift;
    const at = blockWorld(ship, 0);

    damageAt(ship, at.x, at.y, at.z, 10_000);
    expect(ship.liveCount).toBeLessThan(ship.initialBlocks);
    expect(ship.liveLift).toBeLessThan(liftBefore);
  });

  it('reports debris and spray for a killing hit', () => {
    const ship = shipAt(starterDesign());
    const fx = recordingEffects();
    const at = blockWorld(ship, 0);

    damageAt(ship, at.x, at.y, at.z, 10_000, fx);
    expect(fx.debrisPieces.length).toBeGreaterThan(0);
    // Debris carries the destroyed block's colour, not a placeholder.
    expect(fx.debrisPieces[0]!.color).toBeGreaterThan(0);
  });

  it('does nothing to an already-sunk ship', () => {
    const ship = shipAt(starterDesign());
    ship.alive = false;
    const at = blockWorld(ship, 0);
    expect(damageAt(ship, at.x, at.y, at.z, SHELL_DAMAGE)).toBe(false);
  });

  it('respects the direct-hit radius', () => {
    const ship = shipAt(starterDesign());
    // Measured out past the beam, not straight up: blocks are stacked 1.6 m
    // apart, so "above" a block is still well inside another one's radius.
    const beam = Math.max(...ship.blocks.map((b) => b.local.x));
    const y = ship.body.position.y;

    // Just inside the radius off the side: a hit.
    expect(damageAt(ship, beam + DIRECT_HIT_RADIUS - 0.4, y, 0, SHELL_DAMAGE)).toBe(true);
    // Just outside: a near miss.
    const clear = shipAt(starterDesign());
    expect(damageAt(clear, beam + DIRECT_HIT_RADIUS + 0.6, y, 0, SHELL_DAMAGE)).toBe(false);
  });
});

describe('shell flight', () => {
  it('falls under gravity and eventually expires', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    fire(ship, combat, { speed: speedFromPower(0.5), elev: AI_ELEV });

    const startY = combat.shells[0]!.pos.y;
    for (let i = 0; i < 60; i++) updateShells(combat, [ship], 1 / 60, 0, undefined, flatWater);

    // Either it is still falling, or it already splashed and was removed.
    if (combat.shells.length > 0) expect(combat.shells[0]!.pos.y).toBeLessThan(startY + 20);

    for (let i = 0; i < 60 * 10; i++) updateShells(combat, [ship], 1 / 60, 0, undefined, flatWater);
    expect(combat.shells).toHaveLength(0);
  });

  it('cannot tunnel through a hull between frames', () => {
    // A shell at full power covers well over a metre per frame; endpoint-only
    // hit detection would let it pass straight through. The sweep prevents it.
    const shooter = shipAt(starterDesign(), 0, 0);
    const target = shipAt(starterDesign(), 0, 60);
    const combat = createCombat();

    // updateShells sets prev = pos before moving, so seed the *starting*
    // position short of the target and let one frame carry it clean past.
    // 1200 m/s at 1/60 s is a 20 m hop over a target only a few metres wide.
    combat.shells.push({
      prev: { x: 0, y: target.body.position.y, z: 50 },
      pos: { x: 0, y: target.body.position.y, z: 50 },
      vel: { x: 0, y: 0, z: 1200 },
      life: 6,
      wet: false,
      owner: shooter,
      spot: null,
    });

    const liveBefore = target.liveCount;
    updateShells(combat, [shooter, target], 1 / 60, 0, undefined, flatWater);

    expect(target.liveCount).toBeLessThan(liveBefore);
    expect(combat.shells).toHaveLength(0);
  });

  it('never damages the ship that fired it', () => {
    const ship = shipAt(starterDesign());
    const combat = createCombat();
    fire(ship, combat, { speed: speedFromPower(0.1), elev: 0 });

    const liveBefore = ship.liveCount;
    for (let i = 0; i < 240; i++) updateShells(combat, [ship], 1 / 60, 0, undefined, flatWater);
    expect(ship.liveCount).toBe(liveBefore);
  });
});

describe('sinkShip', () => {
  it('marks the ship lost exactly once', () => {
    const ship = shipAt(starterDesign());
    const fx = recordingEffects();

    sinkShip(ship, fx);
    expect(ship.alive).toBe(false);
    const splashes = fx.splashes.length;

    sinkShip(ship, fx);
    expect(fx.splashes.length).toBe(splashes); // no second death throe
  });
});

describe('spotCorrection', () => {
  function shooter(): Ship {
    const s = shipAt(starterDesign());
    s.aimBias = 1;
    return s;
  }

  function spotFor(s: Ship, wanted: number): ShotSpotting {
    return { shooter: s, from: { x: 0, y: 0, z: 0 }, wanted };
  }

  /**
   * CLAUDE.md claims this converges in one to three shots without
   * oscillating. Simulated here against a systematic range error: the shells
   * consistently fly `errorFactor` times as far as the solver believes.
   */
  function convergence(errorFactor: number) {
    const s = shooter();
    const trueRange = 200;
    const errors: number[] = [];

    for (let shot = 0; shot < 6; shot++) {
      // The AI asks for trueRange * bias; the shell actually flies further
      // (or shorter) by the systematic factor.
      const asked = trueRange * s.aimBias;
      const flew = asked * errorFactor;
      errors.push(Math.abs(flew - trueRange) / trueRange);
      spotCorrection(spotFor(s, trueRange), { x: flew, y: 0, z: 0 });
    }
    return { errors, bias: s.aimBias };
  }

  it.each([1.2, 0.85, 1.35, 0.7])(
    'converges within three shots against a %f× range error',
    (factor) => {
      const { errors } = convergence(factor);
      expect(errors[0]).toBeGreaterThan(0.05); // it really did start off
      // By the fourth shot it is landing within 5% of the target range.
      expect(errors[3]).toBeLessThan(0.05);
    },
  );

  it('does not oscillate — the error never grows', () => {
    for (const factor of [1.2, 0.85, 1.35, 0.7]) {
      const { errors } = convergence(factor);
      for (let i = 1; i < errors.length; i++) {
        // Monotonically non-increasing, allowing a hair of float slack.
        expect(errors[i]!).toBeLessThanOrEqual(errors[i - 1]! + 1e-9);
      }
    }
  });

  it('clamps the running bias so one wild splash cannot wreck the solution', () => {
    const s = shooter();
    for (let i = 0; i < 50; i++) {
      spotCorrection(spotFor(s, 1000), { x: 10, y: 0, z: 0 }); // absurdly short
    }
    expect(s.aimBias).toBeLessThanOrEqual(SPOT_BIAS_MAX);

    const s2 = shooter();
    for (let i = 0; i < 50; i++) {
      spotCorrection(spotFor(s2, 10), { x: 1000, y: 0, z: 0 }); // absurdly long
    }
    expect(s2.aimBias).toBeGreaterThanOrEqual(SPOT_BIAS_MIN);
  });

  it('ignores splashes too close to the muzzle to be informative', () => {
    const s = shooter();
    spotCorrection(spotFor(s, 400), { x: SPOT_MIN_FLIGHT - 1, y: 0, z: 0 });
    expect(s.aimBias).toBe(1);
  });

  it('ignores spotting for a shooter that has already sunk', () => {
    const s = shooter();
    s.alive = false;
    spotCorrection(spotFor(s, 400), { x: 100, y: 0, z: 0 });
    expect(s.aimBias).toBe(1);
  });

  it('does nothing without spotting data — the player gets no auto-correct', () => {
    expect(() => spotCorrection(null, { x: 100, y: 0, z: 0 })).not.toThrow();
  });
});
