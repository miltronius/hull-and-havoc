/**
 * The game: mode switching, the main loop, and everything wired together.
 *
 * This is the only place that calls `world.step`, and the only place that
 * writes {@link telemetry}. Systems above it stay pure functions over ship
 * state; the UI below it reads telemetry and reacts to the events declared
 * here. Nothing in this module knows React exists.
 */

import * as THREE from 'three';

import { enemyAI } from './combat/ai';
import {
  predictImpact,
  rangeTo,
  speedFromPower,
} from './combat/ballistics';
import {
  createCombat,
  fire,
  fireTorpedo,
  sinkShip,
  updateShells,
  updateTorpedoes,
  type Combat,
} from './combat/weapons';
import {
  AI_ELEV,
  CANNON_MAX_DEPTH,
  DEPTH_MAX,
  ELEV_MAX,
  ELEV_MIN,
  RELOAD_SURFACE,
  SEABED,
  TORP_MIN_DEPTH,
  TORP_RELOAD,
  TRAV_LIMIT,
  WATER_LEVEL,
} from './constants';
import { createBuildView, createEditor, type BuildView, type Editor, type Tool } from './build/build-mode';
import { bindPointer } from './input/pointer';
import {
  createInputState,
  readDepth,
  readPitchTrim,
  readRollTrim,
  readSteer,
  readThrottle,
  type InputState,
} from './input/state';
import { clamp, DEG } from './math';
import { createPhysicsWorld, stepWorld } from './physics/world';
import { createEffects, type SceneEffects } from './render/effects';
import { createProjectileViews, type ProjectileViews } from './render/projectiles';
import {
  applyDepthLighting,
  cameraDepth,
  lampDepthFactor,
  updateCamera,
} from './scene/camera';
import { createGodRays, type GodRays } from './scene/godrays';
import { createOcean, type Ocean } from './scene/ocean';
import { createReticle, type Reticle } from './scene/reticle';
import { createStage, handleResize, type Stage } from './scene/renderer';
import { applyBuoyancy, shipDepth, updateFlooding } from './ship/buoyancy';
import { buildShip, removeShip } from './ship/compiler';
import { designStats, enemyDesign, starterDesign } from './ship/design';
import { applyThrust, applyTrim, updateDepthControl } from './ship/helm';
import {
  aimBarrels,
  attachShipView,
  disposeShipView,
  reapDeadBlocks,
  syncShipView,
  updateLamps,
  updatePlanes,
  type ShipView,
} from './ship/view';
import { resetTelemetry, telemetry } from './telemetry';
import type { Design, Ship } from './types';

export type Mode = 'build' | 'battle';
export type Result = 'win' | 'lose';

export interface GameEvents {
  onModeChange?(mode: Mode): void;
  onResult?(result: Result): void;
  /** Fired whenever the shipyard design changes, so the report can refresh. */
  onDesignChange?(design: Design): void;
}

/** A ship must be doomed *and* properly under for this long before we call it. */
const SINK_CONFIRM_SECONDS = 2.5;
/** ...and "properly under" means this deep. */
const SINK_CONFIRM_DEPTH = -14;
/** Cap the frame delta so a background tab does not explode the simulation. */
const MAX_FRAME_DT = 0.05;

export class Game {
  readonly stage: Stage;
  readonly input: InputState;

  private readonly ocean: Ocean;
  private readonly godRays: GodRays;
  private readonly reticle: Reticle;
  private readonly buildView: BuildView;
  private readonly editor: Editor;
  private readonly effects: SceneEffects;
  private readonly projectiles: ProjectileViews;

  private readonly world = createPhysicsWorld().world;
  private readonly combat: Combat = createCombat();
  private readonly ships: Ship[] = [];
  private readonly views = new Map<Ship, ShipView>();

  private playerShip: Ship | null = null;
  private enemyShip: Ship | null = null;

  design: Design = starterDesign();
  tool: Tool = 'hull';
  mode: Mode = 'build';
  gameOver = false;

  private readonly isTouch = matchMedia('(pointer: coarse)').matches;
  private readonly events: GameEvents;
  private readonly teardown: Array<() => void> = [];
  private last = performance.now();
  private running = false;

  constructor(mount: HTMLElement, events: GameEvents = {}) {
    this.events = events;
    this.stage = createStage(mount);
    this.input = createInputState();

    this.ocean = createOcean(this.stage.scene);
    this.godRays = createGodRays(this.stage.scene);
    this.reticle = createReticle(this.stage.scene);
    this.buildView = createBuildView(this.stage.scene);
    this.editor = createEditor(this.buildView, this.stage.camera);
    this.effects = createEffects(this.stage.scene);
    this.projectiles = createProjectileViews(this.stage.scene);

    this.teardown.push(handleResize(this.stage));
    this.teardown.push(
      bindPointer(this.stage.renderer.domElement as HTMLCanvasElement, this.input, {
        onTap: (x, y) => this.onTap(x, y),
      }),
    );
    this.teardown.push(this.bindKeyboard());
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.enterBuild();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.running = false;
    for (const off of this.teardown) off();
    this.teardown.length = 0;
  }

  // ── modes ──────────────────────────────────────────────────────────────

  enterBuild(): void {
    this.mode = 'build';
    this.gameOver = false;
    this.clearShips();
    this.combat.shells.length = 0;
    this.combat.torpedoes.length = 0;
    this.projectiles.clear();
    this.effects.clear();
    resetTelemetry();

    this.buildView.setVisible(true);
    this.reticle.setVisible(false);

    this.input.camera.yaw = 0.6;
    this.input.camera.pitch = 0.5;
    this.input.camera.dist = 22;

    this.refreshBuildView();
    this.events.onModeChange?.('build');
  }

  /** @returns false if the design is unsailable (empty, or has loose blocks). */
  enterBattle(): boolean {
    const stats = designStats(this.design);
    if (stats.count === 0 || !stats.connected) return false;

    this.mode = 'battle';
    this.gameOver = false;
    this.buildView.setVisible(false);

    this.playerShip = this.spawn(this.design, { x: 0, z: 0, heading: 0 }, true);
    this.enemyShip = this.spawn(enemyDesign(), { x: 70, z: 60, heading: Math.PI }, false);

    this.input.aim.power = 0.5;
    this.input.aim.elev = (10 * Math.PI) / 180;
    this.input.aim.trav = 0;
    this.input.camera.yaw = 0;
    this.input.camera.pitch = 0.28;
    this.input.camera.dist = 24;

    this.events.onModeChange?.('battle');
    return true;
  }

  private spawn(design: Design, at: { x: number; z: number; heading: number }, isPlayer: boolean): Ship {
    const ship = buildShip(this.world, design, at, isPlayer);
    this.ships.push(ship);
    this.views.set(ship, attachShipView(this.stage.scene, ship));
    return ship;
  }

  private clearShips(): void {
    for (const ship of this.ships) {
      const view = this.views.get(ship);
      if (view) disposeShipView(this.stage.scene, view);
      removeShip(this.world, ship);
    }
    this.ships.length = 0;
    this.views.clear();
    this.playerShip = null;
    this.enemyShip = null;
  }

  // ── shipyard ───────────────────────────────────────────────────────────

  refreshBuildView(): void {
    this.buildView.rebuild(this.design);
    this.events.onDesignChange?.(this.design);
  }

  setDesign(design: Design): void {
    this.design = design;
    this.refreshBuildView();
  }

  private onTap(x: number, y: number): void {
    if (this.mode !== 'build') return;
    if (this.editor.tryEdit(x, y, this.design, this.tool)) this.refreshBuildView();
  }

  // ── input ──────────────────────────────────────────────────────────────

  private bindKeyboard(): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
      this.input.keys[e.code] = true;
      if (this.mode !== 'battle' || !this.playerShip) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.firePlayerGun();
          break;
        case 'KeyT':
          e.preventDefault();
          fireTorpedo(this.playerShip, this.combat, this.effects);
          break;
        case 'KeyH':
          e.preventDefault();
          this.toggleAutoDepth();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.nudgeElev(2);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.nudgeElev(-2);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.nudgeTrav(-2);
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.nudgeTrav(2);
          break;
        case 'BracketRight':
          e.preventDefault();
          this.nudgePower(0.04);
          break;
        case 'BracketLeft':
          e.preventDefault();
          this.nudgePower(-0.04);
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.input.keys[e.code] = false;
    };

    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    return () => {
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
    };
  }

  firePlayerGun(): void {
    if (!this.playerShip) return;
    fire(this.playerShip, this.combat, {
      speed: speedFromPower(this.input.aim.power),
      elev: this.input.aim.elev,
      trav: this.input.aim.trav,
      effects: this.effects,
    });
  }

  firePlayerTorpedo(): void {
    if (!this.playerShip) return;
    fireTorpedo(this.playerShip, this.combat, this.effects);
  }

  toggleAutoDepth(): void {
    const s = this.playerShip;
    if (!s) return;
    s.autoDepth = !s.autoDepth;
    if (s.autoDepth) s.targetDepth = shipDepth(s);
  }

  nudgePower(d: number): void {
    this.input.aim.power = clamp(this.input.aim.power + d, 0, 1);
  }

  nudgeElev(deg: number): void {
    this.input.aim.elev = clamp(this.input.aim.elev + deg * (Math.PI / 180), ELEV_MIN, ELEV_MAX);
  }

  nudgeTrav(deg: number): void {
    this.input.aim.trav = clamp(
      this.input.aim.trav + deg * (Math.PI / 180),
      -TRAV_LIMIT,
      TRAV_LIMIT,
    );
  }

  setPower(pct: number): void {
    this.input.aim.power = clamp(pct / 100, 0, 1);
  }

  setElev(pct: number): void {
    this.input.aim.elev = ELEV_MIN + (ELEV_MAX - ELEV_MIN) * clamp(pct / 100, 0, 1);
  }

  setTrav(pct: number): void {
    this.input.aim.trav = TRAV_LIMIT * clamp(pct / 100, -1, 1);
  }

  // ── main loop ──────────────────────────────────────────────────────────

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    const t = now / 1000;

    const focus = this.playerShip && this.mode === 'battle' ? this.playerShip.body.position : { x: 0, z: 0 };
    this.ocean.update(focus.x, focus.z, t);

    if (this.mode === 'battle') this.stepBattle(dt, t);

    this.effects.update(dt, t);
    this.projectiles.sync(this.combat);
    this.updateCameraAndLighting(dt, t);
    if (this.mode === 'battle') this.writeTelemetry(t);

    this.stage.renderer.render(this.stage.scene, this.stage.camera);
  };

  private stepBattle(dt: number, t: number): void {
    this.controlPlayer(dt);
    if (!this.gameOver && this.enemyShip && this.playerShip) {
      enemyAI(this.enemyShip, this.playerShip, dt, {
        combat: this.combat,
        t,
        effects: this.effects,
      });
    }

    for (const s of this.ships) {
      if (s.reload > 0) s.reload -= dt;
      if (s.torpReload > 0) s.torpReload -= dt;
      updateFlooding(s, dt);
      applyBuoyancy(s, t);
    }

    updateTorpedoes(this.combat, this.ships, dt, t, this.effects);

    const lampDepth = lampDepthFactor(cameraDepth(this.stage, t));
    for (const s of this.ships) {
      const view = this.views.get(s);
      if (!view) continue;
      updatePlanes(s, view, dt);
      updateLamps(view, lampDepth);
    }

    stepWorld(this.world, dt);

    for (const s of this.ships) {
      const view = this.views.get(s);
      if (view) {
        syncShipView(s, view);
        reapDeadBlocks(s, view);
      }
      if (s.alive) this.checkSunk(s, dt);
    }

    updateShells(this.combat, this.ships, dt, t, this.effects);
    this.checkResult();
  }

  /**
   * A ship is lost when it has nothing left, or it can no longer float and has
   * gone properly under for a while. Emergent, not an HP bar — and the delay
   * is what stops a temporary dip in a wave trough being called a sinking.
   */
  private checkSunk(s: Ship, dt: number): void {
    const doomed = !s.buoyant && s.body.position.y < SINK_CONFIRM_DEPTH;
    s.sinkTimer = doomed ? s.sinkTimer + dt : 0;

    if (s.liveCount === 0 || s.sinkTimer > SINK_CONFIRM_SECONDS || s.body.position.y < SEABED + 12) {
      sinkShip(s, this.effects);
    }
  }

  private checkResult(): void {
    if (this.gameOver) return;
    if (this.enemyShip && !this.enemyShip.alive) {
      this.gameOver = true;
      this.events.onResult?.('win');
    } else if (this.playerShip && !this.playerShip.alive) {
      this.gameOver = true;
      this.events.onResult?.('lose');
    }
  }

  /** The player keeps helm control after the battle is decided. */
  private controlPlayer(dt: number): void {
    const s = this.playerShip;
    if (!s || !s.alive) return;

    applyThrust(s, readThrottle(this.input, this.isTouch), readSteer(this.input, this.isTouch));
    updateDepthControl(s, dt, readDepth(this.input));
    applyTrim(s, readPitchTrim(this.input), readRollTrim(this.input));
  }

  private updateCameraAndLighting(dt: number, t: number): void {
    let target = { x: 0, y: 2.5, z: 0, heading: 0 };
    if (this.mode === 'battle' && this.playerShip) {
      const pb = this.playerShip.body;
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
        pb.quaternion as unknown as THREE.Quaternion,
      );
      target = {
        x: pb.position.x,
        y: pb.position.y + 1.5,
        z: pb.position.z,
        heading: Math.atan2(fwd.x, fwd.z),
      };
    }

    updateCamera(this.stage, this.input.camera, target, dt, t);

    const camDepth = cameraDepth(this.stage, t);
    this.ocean.deep.visible = camDepth > 0;
    applyDepthLighting(this.stage, camDepth);
    this.godRays.update(
      this.stage.camera.position.x,
      this.stage.camera.position.z,
      camDepth,
      t,
      Math.atan2(this.stage.sun.position.x, this.stage.sun.position.z),
    );
  }

  // ── telemetry ──────────────────────────────────────────────────────────

  private writeTelemetry(t: number): void {
    const s = this.playerShip;
    if (!s) return;
    const view = this.views.get(s);
    const aim = this.input.aim;
    const depth = shipDepth(s);

    telemetry.hullPct = Math.round((s.liveCount / s.initialBlocks) * 100);
    telemetry.buoyant = s.buoyant;
    telemetry.alive = s.alive;

    telemetry.depth = Math.max(0, WATER_LEVEL - s.body.position.y);
    telemetry.orderedDepth = clamp(s.targetDepth, 0, DEPTH_MAX);
    telemetry.hasTanks = s.ballastTanks > 0;
    telemetry.ballast = s.ballast;
    telemetry.autoDepth = s.autoDepth;
    telemetry.submarine = depth > TORP_MIN_DEPTH;

    telemetry.flooding = s.flooding;
    telemetry.floodCritical = s.flooding > 0.6;
    telemetry.overLimit = s.tiltDeg > s.capsizeAngle;
    telemetry.pumpsDead = s.engines === 0 && s.flooding > 0.05;

    // Signed pitch and roll, from the hull's own axes.
    const q = s.body.quaternion as unknown as THREE.Quaternion;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    telemetry.pitchDeg = Math.asin(clamp(fwd.y, -1, 1)) * DEG;
    telemetry.rollDeg = Math.asin(clamp(right.y, -1, 1)) * DEG;
    telemetry.heelDeg = s.tiltDeg;
    telemetry.capsizeAngle = s.capsizeAngle;

    const cmd = s.trimCmd;
    const pressing = cmd.pitch !== 0 || cmd.roll !== 0;
    telemetry.planeAuth = cmd.auth;
    if (!pressing) {
      telemetry.planeState = 'idle';
      telemetry.planeLabel = 'Planes idle';
    } else if (cmd.auth <= 0.02) {
      telemetry.planeState = 'no-flow';
      telemetry.planeLabel = 'No flow — dive first';
    } else {
      telemetry.planeState = 'active';
      const dir =
        cmd.pitch > 0
          ? 'BOW UP'
          : cmd.pitch < 0
            ? 'BOW DOWN'
            : cmd.roll > 0
              ? 'ROLL PORT'
              : 'ROLL STBD';
      telemetry.planeLabel = `${dir} ${Math.round(cmd.auth * 100)}%`;
    }

    // ── weapons ──
    if (s.cannons === 0) {
      telemetry.reloadState = 'destroyed';
      telemetry.reloadPct = 0;
    } else if (s.reload > 0) {
      telemetry.reloadState = 'reloading';
      telemetry.reloadPct = 1 - s.reload / (s.reloadMax || RELOAD_SURFACE);
    } else {
      telemetry.reloadState = depth > CANNON_MAX_DEPTH ? 'too-deep' : 'ready';
      telemetry.reloadPct = 1;
    }

    telemetry.hasTorpedoes = s.torpedoes > 0;
    if (s.torpedoes === 0) {
      telemetry.torpedoState = 'none';
      telemetry.torpedoPct = 1;
    } else if (s.torpReload > 0) {
      telemetry.torpedoState = 'reloading';
      telemetry.torpedoPct = 1 - s.torpReload / (s.torpReloadMax || TORP_RELOAD);
    } else {
      telemetry.torpedoState = depth < TORP_MIN_DEPTH ? 'too-shallow' : 'ready';
      telemetry.torpedoPct = 1;
    }

    // ── aiming ──
    telemetry.powerPct = Math.round(aim.power * 100);
    telemetry.elevDeg = Math.round(aim.elev * DEG);
    telemetry.travDeg = Math.round(aim.trav * DEG);

    if (view) aimBarrels(s, view, aim.elev, aim.trav);
    if (this.enemyShip) {
      const ev = this.views.get(this.enemyShip);
      if (ev) aimBarrels(this.enemyShip, ev, AI_ELEV, 0);
      telemetry.enemyHullPct = Math.max(
        0,
        Math.round((this.enemyShip.liveCount / this.enemyShip.initialBlocks) * 100),
      );
    }

    // ── reticle ──
    const canAim = s.alive && s.cannons > 0 && depth <= CANNON_MAX_DEPTH;
    const hit = canAim
      ? predictImpact(s, speedFromPower(aim.power), t, aim.elev, aim.trav)
      : null;

    if (hit) {
      this.reticle.setVisible(true);
      this.reticle.place(hit.point.x, hit.point.y, hit.point.z, t);
      telemetry.range = rangeTo(s, hit);
      const e = this.enemyShip;
      const onTarget =
        !!e &&
        e.alive &&
        Math.hypot(hit.point.x - e.body.position.x, hit.point.z - e.body.position.z) < 5;
      this.reticle.setOnTarget(onTarget);
    } else {
      this.reticle.setVisible(false);
      telemetry.range = null;
    }
  }
}
