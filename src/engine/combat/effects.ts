/**
 * The seam between combat logic and things you can see.
 *
 * Weapons need to spawn spray, debris and muzzle flash, but none of that is
 * simulation — it is presentation. Routing it through an interface keeps
 * `weapons.ts` free of Three.js, so damage, hit detection and reload timing
 * can all be tested in Node. The view layer supplies the real implementation;
 * tests supply {@link nullEffects} or a recording stub.
 */

export interface Effects {
  /** Water spray, sparks, smoke — `count` particles thrown out by `spread`. */
  splash(x: number, y: number, z: number, color: number, count: number, spread: number): void;
  /** A tumbling chunk of destroyed hull. */
  debris(x: number, y: number, z: number, color: number): void;
}

/** Discards everything. The default in headless runs and tests. */
export const nullEffects: Effects = {
  splash: () => {},
  debris: () => {},
};

/** Records calls, for asserting that something visible happened. */
export function recordingEffects(): Effects & {
  splashes: Array<{ x: number; y: number; z: number; color: number; count: number }>;
  debrisPieces: Array<{ x: number; y: number; z: number; color: number }>;
} {
  const splashes: Array<{ x: number; y: number; z: number; color: number; count: number }> = [];
  const debrisPieces: Array<{ x: number; y: number; z: number; color: number }> = [];
  return {
    splashes,
    debrisPieces,
    splash: (x, y, z, color, count) => {
      splashes.push({ x, y, z, color, count });
    },
    debris: (x, y, z, color) => {
      debrisPieces.push({ x, y, z, color });
    },
  };
}
