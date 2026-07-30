/**
 * Gaps in `@types/cannon`.
 *
 * `Body.boundingRadius` genuinely exists in cannon 0.6.2 — `updateBoundingRadius()`
 * assigns it (`build/cannon.js:5721`) and the broadphase reads it — but the
 * DefinitelyTyped package never declared it. Declaring it here rather than
 * casting at the call site keeps the reason documented and the usage honest.
 *
 * This whole file disappears in Phase 2: cannon-es ships its own types.
 */

declare namespace CANNON {
  interface Body {
    /**
     * Radius of the sphere that encloses every shape in the body, measured
     * from the centre of mass. Recomputed by `updateBoundingRadius()`, which
     * must be called after splicing a shape out of a compound.
     */
    boundingRadius: number;
  }
}
