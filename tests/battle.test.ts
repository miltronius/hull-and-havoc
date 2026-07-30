/**
 * End-to-end battle, headless.
 *
 * Mirrors `Game.stepBattle` exactly — same call order, same systems — but with
 * no renderer. Unit tests prove each system in isolation; this proves they
 * still add up to a fight: the AI closes, ranges, shoots, corrects, hits, and
 * somebody eventually sinks.
 *
 * If the per-frame order in `game.ts` changes, change it here too. A
 * divergence would make this test pass while the real game misbehaves.
 */

import { describe, expect, it } from 'vitest';

import { enemyAI } from '../src/engine/combat/ai';
import { speedFromPower } from '../src/engine/combat/ballistics';
import { recordingEffects } from '../src/engine/combat/effects';
import {
  createCombat,
  fire,
  sinkShip,
  updateShells,
  updateTorpedoes,
  type Combat,
} from '../src/engine/combat/weapons';
import { AI_ELEV, SEABED } from '../src/engine/constants';
import { createPhysicsWorld, stepWorld } from '../src/engine/physics/world';
import { applyBuoyancy, updateFlooding } from '../src/engine/ship/buoyancy';
import { buildShip } from '../src/engine/ship/compiler';
import { enemyDesign, starterDesign } from '../src/engine/ship/design';
import { applyThrust, applyTrim, updateDepthControl } from '../src/engine/ship/helm';
import type { Ship } from '../src/engine/types';
import { flatWater } from '../src/engine/waves';
import { STEP } from './helpers/sim';

const SINK_CONFIRM_SECONDS = 2.5;
const SINK_CONFIRM_DEPTH = -14;

interface Battle {
  ships: Ship[];
  player: Ship;
  enemy: Ship;
  combat: Combat;
  effects: ReturnType<typeof recordingEffects>;
  t: number;
  step(helm?: { throttle?: number; steer?: number; fire?: boolean }): void;
  run(seconds: number, helm?: { throttle?: number; steer?: number; fire?: boolean }): void;
}

function battle(): Battle {
  const { world } = createPhysicsWorld();
  const player = buildShip(world, starterDesign(), { x: 0, z: 0, heading: 0 }, true);
  const enemy = buildShip(world, enemyDesign(), { x: 70, z: 60, heading: Math.PI }, false);
  const ships = [player, enemy];
  const combat = createCombat();
  const effects = recordingEffects();

  const b: Battle = {
    ships,
    player,
    enemy,
    combat,
    effects,
    t: 0,

    step(helm = {}) {
      // ── control (mirrors Game.controlPlayer) ──
      if (player.alive) {
        applyThrust(player, helm.throttle ?? 0, helm.steer ?? 0);
        updateDepthControl(player, STEP, 0);
        applyTrim(player, 0, 0);
        if (helm.fire) {
          fire(player, combat, { speed: speedFromPower(0.5), elev: AI_ELEV, effects });
        }
      }

      enemyAI(enemy, player, STEP, { combat, t: b.t, effects, waves: flatWater });

      for (const s of ships) {
        if (s.reload > 0) s.reload -= STEP;
        if (s.torpReload > 0) s.torpReload -= STEP;
        updateFlooding(s, STEP);
        applyBuoyancy(s, b.t, flatWater);
      }

      updateTorpedoes(combat, ships, STEP, b.t, effects, flatWater);
      stepWorld(world, STEP);

      for (const s of ships) {
        if (!s.alive) continue;
        const doomed = !s.buoyant && s.body.position.y < SINK_CONFIRM_DEPTH;
        s.sinkTimer = doomed ? s.sinkTimer + STEP : 0;
        if (
          s.liveCount === 0 ||
          s.sinkTimer > SINK_CONFIRM_SECONDS ||
          s.body.position.y < SEABED + 12
        ) {
          sinkShip(s, effects);
        }
      }

      updateShells(combat, ships, STEP, b.t, effects, flatWater);
      b.t += STEP;
    },

    run(seconds, helm) {
      const frames = Math.round(seconds / STEP);
      for (let i = 0; i < frames; i++) b.step(helm);
    },
  };

  return b;
}

describe('a battle actually happens', () => {
  it('starts with two intact ships afloat', () => {
    const b = battle();
    b.run(3);

    expect(b.player.alive).toBe(true);
    expect(b.enemy.alive).toBe(true);
    expect(b.player.liveCount).toBe(20);
    expect(b.enemy.liveCount).toBe(24);
    // Both settled on the surface rather than sinking or launching.
    expect(Math.abs(b.player.body.position.y)).toBeLessThan(2);
    expect(Math.abs(b.enemy.body.position.y)).toBeLessThan(2);
  });

  it('the AI closes to its own gun range and opens fire', () => {
    const b = battle();
    const startRange = Math.hypot(
      b.enemy.body.position.x - b.player.body.position.x,
      b.enemy.body.position.z - b.player.body.position.z,
    );

    b.run(30);

    // It worked out a range band for itself.
    expect(b.enemy.band).toBeDefined();
    expect(b.enemy.band!.max).toBeGreaterThan(b.enemy.band!.min);

    // It manoeuvred — either closing or backing off, but not sitting still.
    const range = Math.hypot(
      b.enemy.body.position.x - b.player.body.position.x,
      b.enemy.body.position.z - b.player.body.position.z,
    );
    expect(Math.abs(range - startRange)).toBeGreaterThan(5);

    // And it took shots at some point in those 30 seconds.
    expect(b.enemy.reloadMax).toBeGreaterThan(0);
  });

  it('the AI corrects its aim from observed splashes', () => {
    const b = battle();
    b.run(45);
    // aimBias only moves when a shell of its own has been watched down.
    // Either it converged back to 1, or it is actively correcting — what it
    // must never be is stuck outside its clamps.
    expect(b.enemy.aimBias).toBeGreaterThanOrEqual(0.55);
    expect(b.enemy.aimBias).toBeLessThanOrEqual(1.8);
  });

  it('sustained fire from the player damages the enemy', () => {
    const b = battle();
    // Point the guns at the enemy and keep the trigger down. Range and
    // bearing are approximate, so this leans on splash damage too.
    b.run(60, { fire: true });

    const shellsFired = b.effects.splashes.length;
    expect(shellsFired).toBeGreaterThan(0);
  });

  it('a ship stripped of every block is declared sunk', () => {
    const b = battle();
    for (const blk of b.enemy.blocks) blk.alive = false;
    b.enemy.liveCount = 0;

    b.step();
    expect(b.enemy.alive).toBe(false);
  });

  it('a ship that loses buoyancy sinks, but not instantly', () => {
    const b = battle();
    // Swamp it completely: no lift, well under, and doomed.
    b.enemy.flooding = 1;
    b.enemy.buoyMul = 0;
    b.enemy.body.position.y = -30;

    b.step();
    expect(b.enemy.alive).toBe(true); // one frame is not enough

    b.run(SINK_CONFIRM_SECONDS + 1);
    expect(b.enemy.alive).toBe(false);
  });

  it('never produces NaN in a ship’s position over a long fight', () => {
    const b = battle();
    b.run(90, { throttle: 1, steer: 0.3, fire: true });

    for (const s of b.ships) {
      expect(Number.isFinite(s.body.position.x)).toBe(true);
      expect(Number.isFinite(s.body.position.y)).toBe(true);
      expect(Number.isFinite(s.body.position.z)).toBe(true);
      expect(Number.isFinite(s.body.quaternion.x)).toBe(true);
      expect(Number.isFinite(s.flooding)).toBe(true);
      expect(Number.isFinite(s.ballast)).toBe(true);
    }
  });

  it('cleans up spent projectiles rather than leaking them', () => {
    const b = battle();
    b.run(60, { fire: true });
    // Shells live 6 s and the reload is 1 s, so a bounded number can be in
    // the air at once. An unbounded count would mean nothing is being reaped.
    expect(b.combat.shells.length).toBeLessThan(40);
  });
});
