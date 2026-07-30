/**
 * Fall of shot correction.
 *
 * When a shell lands in the water the shooter watches where the splash went
 * and adjusts its next firing solution — the same thing a real gunnery officer
 * does. This converges in one to three shots without oscillating, which is why
 * the AI stops consistently over- or under-shooting after its opening rounds.
 *
 * Its own module because both `weapons.ts` (which observes the splash) and
 * `ai.ts` (which fires the corrected shot) need it, and importing one from
 * the other would be circular.
 */

import { clamp } from '../math';
import type { Point3 } from './ballistics';
import type { ShotSpotting } from '../types';

/** Per-shot correction is clamped, so one wild splash cannot wreck the solution. */
export const SPOT_STEP_MIN = 0.8;
export const SPOT_STEP_MAX = 1.25;
/** ...and the running bias is clamped too, so it cannot wander off entirely. */
export const SPOT_BIAS_MIN = 0.55;
export const SPOT_BIAS_MAX = 1.8;
/** Splashes closer than this to the muzzle carry no useful information. */
export const SPOT_MIN_FLIGHT = 5;

/**
 * Fold one observed splash into the shooter's running aim bias.
 *
 * `ratio > 1` means the shell fell short of where it was aimed, so the next
 * shot is asked for more range.
 */
export function spotCorrection(spot: ShotSpotting | null, impact: Point3): void {
  if (!spot || !spot.shooter.alive) return;

  const flew = Math.hypot(impact.x - spot.from.x, impact.z - spot.from.z);
  if (flew < SPOT_MIN_FLIGHT) return;

  const ratio = spot.wanted / flew;
  spot.shooter.aimBias = clamp(
    spot.shooter.aimBias * clamp(ratio, SPOT_STEP_MIN, SPOT_STEP_MAX),
    SPOT_BIAS_MIN,
    SPOT_BIAS_MAX,
  );
}
