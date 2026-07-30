/**
 * The sea surface, as a pure function of position and time.
 *
 * This deliberately lives outside `scene/` and imports nothing. Buoyancy,
 * the camera, the shell/torpedo/debris updates and the ocean mesh all sample
 * the *same* function, which is what keeps the water you see identical to the
 * water the physics uses.
 *
 * A related bug is worth remembering: the visible surface once desynced from
 * the physics surface the further you sailed from the origin, because wave
 * heights were computed from the ocean mesh's *local* vertex coordinates
 * before the mesh was translated to follow the player. Always pass world
 * coordinates here.
 */

/** Metres of surface displacement above {@link WATER_LEVEL} at (x, z), time t. */
export function waveHeight(x: number, z: number, t: number): number {
  return (
    Math.sin(x * 0.05 + t * 0.9) * 0.55 +
    Math.sin(z * 0.07 + t * 1.1) * 0.45 +
    Math.sin((x + z) * 0.04 + t * 0.6) * 0.35 +
    Math.sin(x * 0.17 - z * 0.11 + t * 1.8) * 0.17 + // chop
    Math.sin(z * 0.23 + x * 0.06 + t * 2.4) * 0.11 // ripple
  );
}

/**
 * A flat sea. Handy in tests: it removes wave noise so a settling-depth or
 * heading-drift assertion measures the thing it claims to measure.
 */
export function flatWater(): number {
  return 0;
}

export type WaveField = (x: number, z: number, t: number) => number;
