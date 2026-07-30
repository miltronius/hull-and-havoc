/**
 * Tiny numeric helpers.
 *
 * The prototype reached for `THREE.MathUtils.clamp` everywhere, including
 * deep inside the physics. Re-implementing the two functions we actually use
 * keeps the simulation modules free of a rendering dependency, which is the
 * whole point of the engine/view split.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;
