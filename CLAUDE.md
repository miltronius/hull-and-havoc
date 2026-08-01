# CLAUDE.md

Guidance for Claude Code (or any future contributor) working on **Hull & Havoc**,
a browser-based naval combat / ship-building game.

## What this is

A browser game (Three.js + cannon.js) where the player builds a ship
block-by-block in a shipyard, then sails it into combat against an AI enemy.
Enough ballast tanks turn the same ship into a submarine.

It began life as a single 2,351-line HTML file. That file is preserved,
frozen, at `legacy/hull-and-havoc-v3.html` — it is the behavioural reference
the port is diffed against, and `tests/legacy-parity.test.ts` literally slices
functions out of it and runs them. **Do not edit it.**

Core design values, in priority order:
1. **Physics-driven emergent gameplay over scripted behavior.** Buoyancy,
   damage, capsizing, and flooding all fall out of a handful of simulated
   quantities (mass, lift, center of mass, tilt angle) rather than scripted
   state machines. When adding a feature, prefer "add a force / add a mass"
   over "add an if-statement that fakes the effect."
2. **Mobile-first touch controls, with full desktop keyboard support.**
   Every control has both a touch affordance and a keybinding.
3. **Gradual incremental polish.** This project grew one small, testable
   change at a time. Keep changes scoped and verifiable.

## Working on it

```
pnpm install
pnpm dev        # Vite on 0.0.0.0:5173 — the network URL works from a phone
pnpm check      # typecheck + lint + tests. Run before calling anything done.
pnpm test       # 113 tests, all headless, ~6s
```

## Architecture

The rule everything else rests on: **`src/engine/` never imports React or
anything from `src/ui/`, and the UI never touches Three.js or the physics
world.** An ESLint `no-restricted-imports` rule enforces both directions —
see `eslint.config.js`. Breaking it would make the simulation unrunnable in
Node and put reconciliation on the 60 Hz hot path.

```
src/
  engine/                    ← vanilla, imperative, headlessly testable
    constants.ts             ← every tuning number + BLOCKS. Single source of truth.
    types.ts  math.ts  waves.ts  telemetry.ts
    physics/world.ts
    ship/     design.ts compiler.ts view.ts buoyancy.ts helm.ts blocks.ts
    combat/   ballistics.ts weapons.ts ai.ts spotting.ts effects.ts
    scene/    renderer.ts ocean.ts godrays.ts camera.ts reticle.ts
    render/   effects.ts projectiles.ts
    input/    state.ts pointer.ts
    build/    build-mode.ts
    game.ts                  ← the ONLY place that calls world.step
  ui/                        ← DOM today, React in Phase 3
    hud.ts hud.css hud.html
  main.ts                    ← the only file that knows about both halves
```

### The pure / view split

`ship/compiler.ts` builds a ship's **physics** — body, shapes, per-block hp —
and imports no Three.js at all. `ship/view.ts` builds its **meshes**, lamps and
dive planes, and pairs them up by iterating `ship.blocks` in the same order.
Views live in a `Map<Ship, ShipView>` rather than as a field on the ship, so
the simulation object never carries a renderer reference.

This split is the reason `tests/physics.test.ts` can compile a real ship and
step it in Node. Keep it. The same pattern applies to combat: projectiles are
plain data in `combat/weapons.ts`, and anything visible goes through the
`Effects` interface (`combat/effects.ts`), which tests stub out.

### Engine → UI

Two channels, deliberately different:

- **Per-frame numbers** (depth, heel, reload %, range) are written in place
  into the single mutable `engine/telemetry.ts` object. No allocation, no
  events. The HUD runs its **own** rAF loop reading it, and diffs before
  touching the DOM — the engine never calls the UI.
- **Discrete state** (mode change, result, design edits) arrives as explicit
  `GameEvents` callbacks, because those genuinely should re-render.

Phase 3 swaps `ui/hud.ts` for React components that bind telemetry through
refs and put discrete state in a store. Nothing in `src/engine` changes.

### Tuning

`src/engine/constants.ts` is the single source of truth for every gameplay
number. This is what made rapid iteration possible — "faster reload" was
always a one-line change. Keep it that way: change behaviour by changing a
constant, not by editing logic downstream. Phase 4 turns it into
`deriveTuning(TUNING, ownedUpgrades)` for the upgrade shop, which preserves the
property rather than breaking it.

Several numbers are pinned by tests (the depth-hold gains, the flood and pump
rates, the block catalogue). Retune them deliberately, and update the test in
the same commit — the failure is the point.

## Testing

113 tests, all headless, all in `tests/`. There is no browser in the loop.

- **`legacy-parity.test.ts`** — slices `waveHeight`, `applyBuoyancy` and
  `predictImpact` verbatim out of the frozen prototype, evaluates them, and
  asserts the ported versions produce the same force, torque and impact
  points across nine ship states. This is what makes "the port didn't change
  the simulation" a falsifiable claim rather than a hope, and it is what
  caught the cannon-es relative-point convention.
  `waveHeight` and `predictImpact` are still asserted **bit-identical**.
  `applyBuoyancy` moved to a `1e-12` relative tolerance during the cannon-es
  swap, for a measured reason documented at the top of that file: 0.6.2
  computed the lift point as `(rot(sp) + pos) - pos` and cannon-es is handed
  `rot(sp)` directly, which differs by one ulp on a heeled hull far from the
  origin. Everything else still matches exactly. Don't loosen it further
  without finding out what changed — a genuinely wrong translation shows up
  at ~1e7 on the same component, not 1e-12.
  The legacy slice runs through a `worldPointBody` proxy that re-imposes
  0.6.2's world-point convention on the reference *only*; without it the
  prototype side would be the broken one.
- **`physics.test.ts`** — the regressions that matter. Each pins a bug that
  was already found the hard way once:
  - depth-hold reaches 90% of a step in ~8.6 s with no overshoot;
  - a submerged, level, unforced hull yaws by **exactly zero** (the
    drag-at-centre-of-mass bug);
  - trim never contributes to `torque.y`, at any heel (the tilted-local-axes
    bug), asserted per frame over a live dive;
  - flooding and pump rates, and that pumps die with the engines;
  - `destroyBlock` keeps the compound body consistent over 20 removals.
- **`ballistics.test.ts`** — the round trip that keeps aiming honest: ask
  `solvePowerForRange` for a range, fire at that power, land there.
- **`combat.test.ts`** — damage, reload gating, swept hit detection (shells
  must not tunnel through a hull between frames), and that `spotCorrection`
  converges within three shots without oscillating.
- **`battle.test.ts`** — a full AI-vs-player fight, headless. Mirrors
  `Game.stepBattle` exactly; **if you change the per-frame order in
  `game.ts`, change it here too**, or this will pass while the game misbehaves.

## Known cannon-es pitfalls (critical — and the ones inherited from 0.6.2)

The engine runs on **cannon-es 0.20**. The migration off cannon 0.6.2 is done;
what follows is the current truth, with the old behaviour noted only where a
future reader might otherwise trust a stale tutorial.

- **`applyForce(force, relativePoint?)` and `applyImpulse(impulse, point?)`
  take a point RELATIVE TO the centre of mass**, and it defaults to zero.
  Verified against the installed `cannon-es.d.ts` and `cannon-es.js:3718`.
  So to push a whole body without inducing rotation, **omit the second
  argument** — that is the idiom used in `helm.ts`, `ai.ts` and the recoil
  path in `weapons.ts`.
  **⚠ This is the reverse of cannon 0.6.2**, where the argument was a *world*
  point and centre-of-mass application meant passing `body.position`. Any
  tutorial, LLM answer or old snippet you find will most likely be written
  the 0.6.2 way. Passing a world point now scales the induced torque by the
  ship's distance from the origin: harmless at spawn, catastrophic at range,
  and completely invisible in a test that keeps its ships near `(0,0,0)`.
  Two call sites genuinely have off-centre points and must convert rather
  than drop the argument — lift in `buoyancy.ts` and the damage knock in
  `weapons.ts`; both are commented in place.
- **`body.applyTorque()` exists now** (it did not in 0.6.2), but the code
  still accumulates into `body.torque.x/y/z` directly — it stays
  allocation-free on the 60 Hz path, and `applyTrim` has to write individual
  components anyway. The solver clears `body.torque` each step either way.
- **`removeShape()` exists** and splices `shapes` / `shapeOffsets` /
  `shapeOrientations` for you, *and* recomputes mass properties and bounding
  radius. `destroyBlock()` still calls `updateMassProperties()` afterwards,
  and the ordering is the reason: it adjusts `body.mass` *after* the removal,
  so without the second call the inertia tensor stays keyed to the
  pre-removal mass. Guard the call with a `shapes.includes()` check —
  cannon-es `console.warn`s on a shape that isn't attached.
- **`world.remove()` is gone; it is `world.removeBody()`.** Renamed, not
  deprecated, so the old name is a straight `TypeError` at runtime.
- **`world.solver` is typed as the abstract `Solver`, which has no
  `iterations`.** Construct a `GSSolver`, set `iterations` on it while it is
  still concretely typed, and pass it to the `World` constructor — see
  `physics/world.ts`. Casting `world.solver` after the fact also compiles but
  hides the intent.
- **`Body.boundingRadius` is properly typed now**, so the old
  `src/types/cannon.d.ts` shim is deleted. The swept hit detection reads it.
- **`world.step(fixedTimeStep, timeSinceLastCall, maxSubSteps)`** — three
  args in that order, unchanged from 0.6.2.
- **Applying drag forces at off-center sample points sums into unwanted
  torque.** Lift can stay per-sample-point (that's what rights a listing
  hull), but drag/damping forces should be applied once at the centre of mass
  (under cannon-es: omit the point) or they silently spin the body — invisible on a wavy
  surface where sample points constantly change, but a constant phantom yaw
  the moment the whole hull is submerged and every point is wet at once.
  This was a real bug, found and fixed during development — don't
  reintroduce it.
- **Horizontal torque axes aren't independent when a body is tilted.**
  Applying pitch/roll torque along the body's *local* right/forward axes
  bleeds into yaw once the hull isn't level (a tilted "right" axis has a
  vertical component). Strip the world-Y component out of trim torques if
  you don't want heel input to also turn the ship.
- Prefer `NaiveBroadphase` and modest solver `iterations` (12 here) — this
  project never needed more for two ships plus projectiles.

## Waiting to bite you: the three.js r128 → r160+ upgrade

Pinned at r128 deliberately — this is the **remaining half of Phase 2**, and
the reason it is still pending is that the cannon-es swap was verifiable
headlessly and this one is not. Two changes will visibly alter the
look, and neither announces itself as an error:

- **Colour management is on by default from r152.** Every hex colour is then
  interpreted as sRGB and converted to linear, so the whole palette shifts.
  Start the migration with `THREE.ColorManagement.enabled = false` to keep the
  diff honest, then enable it as a separate, deliberate re-grade.
- **Light units changed with `useLegacyLights` defaulting off from r155.**
  Point light intensity becomes physical, so the underwater lamps
  (`updateLamps`, `0.3 + lampDepth * 6.5`) and their `distance`/`decay` all
  need retuning.
- `renderer.outputEncoding` → `outputColorSpace`. `MathUtils`, `FogExp2`,
  `SpriteMaterial`, `AdditiveBlending` and `GridHelper` are unchanged.

While retuning underwater visuals, do **not** give the water material an
emissive glow — see the god-rays note below.

## Notable bugs fixed during development (context for future changes)

- **Ship sinking to unbounded depth**: there was no seabed collider early on;
  a ship that couldn't float (e.g. mid-ballast-change) fell forever. Fixed
  with a static seabed plane at `SEABED` and a `sinkTimer` that requires
  being doomed *and* properly underwater for ~2.5s before declaring defeat —
  avoids premature "You Sank" on a temporary dip.
- **Double block placement on touch**: mobile browsers fire synthetic mouse
  events after `touchend`. Fixed with a 700ms suppression window on mouse
  input following any touch, plus a 120ms debounce on `tryEdit()` as a
  backstop.
- **Camera clipping through the seabed / through the water plane**: clamp
  camera Y above `SEABED + margin`, and push the camera out of a small band
  around the live wave height so it's never exactly coplanar with the
  surface (which sliced the view in two).
- **Visible wave surface desynced from physics/camera surface** the further
  you got from the origin: wave heights were computed from the mesh's local
  vertex coordinates *before* the mesh was translated to follow the player.
  Fix: translate the mesh first, then compute `waveHeight` using world
  coordinates (`localVertex + focus`).
- **Phantom yaw on submerged submarines**: see the drag-at-center-of-mass
  pitfall above.
- **Trim input bleeding into heading**: see the tilted-local-axes pitfall
  above.
- **AI firing consistently over/under target**: the AI now tracks a running
  `aimBias` multiplier per ship, corrected each time a shell's splash
  location is compared against where it was aimed (`spotCorrection`) —
  converges in 1–3 shots without oscillating (verified numerically during
  development).
- **Underwater "god rays" / Snell's window invisible**: the effect is
  additive-blended, so it only reads against a *darker* background. An
  earlier attempt gave the water material its own emissive glow to keep the
  underside from looking pitch black, which killed the contrast the
  additive effect needed. Don't add emissive glow to the water material.

## Gameplay systems reference

- **Buoyancy**: `applyBuoyancy` iterates each *alive* block's two sample
  points, computes local submersion depth against `waveHeight`, and applies
  lift proportional to `blk.lift` and a `floatPower` factor derived from
  ballast fraction, flooding fraction, and a damage multiplier. Losing blocks
  (via `destroyBlock`) directly reduces total lift and mass — no separate
  "hull integrity" number; buoyancy IS the health system.
- **Balance / capsizing**: `designStats` computes mass-weighted and
  lift-weighted centroids; the horizontal offset between them predicts
  listing, and hull width (`spreadX`) sets a `capsizeAngle` (wider hull =
  more tolerance). `updateFlooding` compares live tilt to that angle each
  frame; exceeding it lets water in (`ship.flooding`), which further cuts
  lift — an intentional death spiral, recoverable only by leveling out
  (pumps run automatically) and only while engines survive (pumps need
  power).
- **Depth control**: `ship.autoDepth` toggles between an autopilot
  (`targetDepth` set by Q/E, a P+D controller trims `ship.ballast` to hold
  it — gains `err*0.13 + verticalVelocity*0.46`) and manual ballast control.
  Measured response for a 20 m step on a stable hull: 90% in **8.6 s** with
  3 mm of overshoot, pinned by `tests/physics.test.ts`. Independent of that,
  I/K and J/L apply pitch/roll trim torque through visible stern dive planes,
  with authority scaling with depth (no grip until there's real water over
  the planes).
- **Weapons**: cannons only fire above `CANNON_MAX_DEPTH`; torpedoes only
  fire below `TORP_MIN_DEPTH`. Aiming is real ballistics
  (`predictImpact`/`gunSolution`) shared between the player's reticle
  prediction, the fire() shell velocity, and the AI's solver — so the
  reticle is always exactly where the shell will go.
- **Damage**: `damageAt` finds the nearest alive block to an impact point,
  applies direct + splash damage, destroys anything at ≤0 hp via
  `destroyBlock`, and applies a world-point impulse for a visible knock.
  There is no ship-level HP bar; "sunk" is derived from `liveCount === 0` or
  sustained loss of buoyancy (see sinking fix above).

## Workflow notes

- **Run `pnpm check` before calling anything done.** Typecheck, lint and 113
  tests take about ten seconds together.
- **Test on a phone.** `pnpm dev` binds to `0.0.0.0`; use the Network URL it
  prints. Mobile-first touch control is a core design value and it is very
  easy to break it without noticing on a desktop.
- **When changing a tuning constant, verify it numerically** rather than
  trusting intuition about PID-like gains. There is now a harness for this:
  `tests/helpers/sim.ts` compiles a real ship and steps it headlessly, so
  measuring a settling time is a few lines rather than a throwaway script.
- **Prefer additive, incremental changes to speculative refactors.** This
  project got where it is through many small reviewable steps.
- **Don't edit `legacy/hull-and-havoc-v3.html`.** The parity tests read it by
  line range; changing it silently invalidates the baseline. The slices are
  guarded by `expect(...).toContain(...)` assertions, so an accidental edit
  fails loudly rather than quietly — but it still means the reference is gone.

## Roadmap

Phase 1 (module extraction on pinned deps) is complete. Remaining, in order —
each phase changes exactly one variable, because the tuning is empirical and
you need to be able to bisect what changed the feel:

- **Phase 2 — dependency modernisation**. Split in two, because "one variable
  at a time" applies *within* the phase: the two halves fail in completely
  different ways and only one of them is testable headlessly.
  - ✅ **cannon 0.6.2 → cannon-es 0.20** — done. Six force/impulse call sites
    converted to the relative-point convention, `removeShape`/`removeBody`
    adopted, the `@types/cannon` shim and the Vite UMD pre-bundle deleted.
    All 113 tests still pass. Verified by deliberately reintroducing the
    world-point bug and confirming the suite fails (it does: 3 tests, the
    parity torque off by 1e7) — do the same for any future physics change,
    because a green suite proves nothing until you know it can go red.
  - ⬜ **three r128 → r160+** — still pending, and deliberately *not*
    bundled with the above. See the colour-management and light-units
    warnings; both change the look without erroring, and no test covers the
    renderer, so this one needs eyes on a real device.
- **Phase 3 — React UI**: replace `src/ui/hud.ts` panel by panel, deleting
  each telemetry binding as its component lands.
- **Phase 4 — game scope**: enemy roster, upgrade shop, blueprint save/load,
  build budget, audio.
