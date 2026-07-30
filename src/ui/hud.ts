/**
 * The HUD, in plain DOM.
 *
 * Phase 3 replaces this with React components. It is written here in the shape
 * that migration wants, so the swap is mechanical:
 *
 * - It runs its **own** `requestAnimationFrame` loop reading
 *   {@link telemetry}, rather than being called by the game loop. That is
 *   exactly what `useTelemetryRef` will do — the engine never calls the UI.
 * - Every per-frame write goes through {@link bindText} / {@link bindStyle},
 *   which diff before touching the DOM. The React version keeps the diff and
 *   swaps the element lookup for a ref.
 *
 * Discrete state — mode changes, results, design edits — arrives as explicit
 * calls instead, because those genuinely should re-render.
 */

import type { Game, Mode, Result } from '../engine/game';
import { designStats } from '../engine/ship/design';
import { telemetry } from '../engine/telemetry';
import type { BlockType, Design } from '../engine/types';
import { clamp } from '../engine/math';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`HUD element #${id} is missing from the markup`);
  return found as T;
};

/** Write `textContent` only when it actually changed. */
function bindText(node: HTMLElement): (v: string) => void {
  let prev: string | null = null;
  return (v) => {
    if (v === prev) return;
    prev = v;
    node.textContent = v;
  };
}

/** Write a style property only when it actually changed. */
function bindStyle(node: HTMLElement, prop: 'width' | 'background' | 'color' | 'display'): (v: string) => void {
  let prev: string | null = null;
  return (v) => {
    if (v === prev) return;
    prev = v;
    node.style.setProperty(prop, v);
  };
}

/** Toggle a class only when the flag changed. */
function bindClass(node: HTMLElement, cls: string): (on: boolean) => void {
  let prev: boolean | null = null;
  return (on) => {
    if (on === prev) return;
    prev = on;
    node.classList.toggle(cls, on);
  };
}

const HULL_OK = 'linear-gradient(90deg,#3fa34d,#7ddc8a)';
const HULL_WARN = 'linear-gradient(90deg,#c8842f,#f5b342)';
const HULL_BAD = 'linear-gradient(90deg,#c8392f,#e8453c)';
const FLOOD_OK = 'linear-gradient(90deg,#2f7fc8,#6fd0e0)';

export interface Hud {
  setMode(mode: Mode): void;
  showResult(result: Result): void;
  refreshShipReport(design: Design): void;
  dispose(): void;
}

export function createHud(game: Game): Hud {
  const isTouch = matchMedia('(pointer: coarse)').matches;

  // ── battle readouts ──
  const hullPct = bindText(el('hullPct'));
  const hullFillW = bindStyle(el('hullFill'), 'width');
  const hullFillBg = bindStyle(el('hullFill'), 'background');
  const ballastPct = bindText(el('ballastPct'));
  const ballastFillW = bindStyle(el('ballastFill'), 'width');
  const floodPct = bindText(el('floodPct'));
  const floodFillW = bindStyle(el('floodFill'), 'width');
  const floodFillBg = bindStyle(el('floodFill'), 'background');
  const floodCrit = bindClass(el('floodRow'), 'crit');

  const pitchVal = bindText(el('pitchVal'));
  const rollVal = bindText(el('rollVal'));
  const horizonLine = el('horizonLine');
  const horizonTrim = bindClass(el('horizonBox'), 'trimming');
  const planeText = bindText(el('planeState'));
  const planeEl = el('planeState');
  const trimModeText = bindText(el('trimMode'));
  const trimModeMan = bindClass(el('trimMode'), 'man');

  const heelVal = bindText(el('heelVal'));
  const heelColor = bindStyle(el('heelVal'), 'color');
  const heelLimit = bindText(el('heelLimit'));
  const heelWarnShow = bindClass(el('heelWarn'), 'show');
  const heelWarnSmall = bindText(el('heelWarn').querySelector('small')!);

  const depthVal = bindText(el('depthVal'));
  const ordDepth = bindText(el('ordDepth'));
  const subBadge = bindClass(el('subBadge'), 'on');
  const enemyHull = bindText(el('enemyHull'));

  const powVal = bindText(el('powVal'));
  const elevVal = bindText(el('elevVal'));
  const travVal = bindText(el('travVal'));
  const rangeVal = bindText(el('rangeVal'));

  const reloadEl = el('reload');
  const reloadReady = bindClass(reloadEl, 'ready');
  const reloadFillW = bindStyle(el('reloadFill'), 'width');
  const reloadLabel = bindText(el('reloadLabel'));
  const torpRowDisplay = bindStyle(el('torpRow'), 'display');
  const torpFillW = bindStyle(el('torpFill'), 'width');
  const torpLabel = bindText(el('torpLabel'));
  const torpLabelColor = bindStyle(el('torpLabel'), 'color');

  const powSlider = el<HTMLInputElement>('powSlider');
  const elevSlider = el<HTMLInputElement>('elevSlider');
  const travSlider = el<HTMLInputElement>('travSlider');

  let lastPlaneState = '';
  let lastHorizon = '';

  // ── per-frame update, on the HUD's own rAF ──
  let raf = 0;
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    if (game.mode !== 'battle') return;

    const hp = telemetry.hullPct;
    hullPct(`${hp}%`);
    hullFillW(`${hp}%`);
    hullFillBg(!telemetry.buoyant ? HULL_BAD : hp < 50 ? HULL_WARN : HULL_OK);

    const bal = Math.round(telemetry.ballast * 100);
    ballastPct(`${bal}%`);
    ballastFillW(`${bal}%`);
    ordDepth(telemetry.hasTanks ? `${telemetry.orderedDepth.toFixed(0)} m` : 'no tanks');

    const fl = Math.round(telemetry.flooding * 100);
    floodPct(`${fl}%`);
    floodFillW(`${fl}%`);
    floodFillBg(fl > 60 ? HULL_BAD : fl > 25 ? HULL_WARN : FLOOD_OK);
    floodCrit(fl > 60);

    pitchVal(`${telemetry.pitchDeg >= 0 ? '+' : ''}${telemetry.pitchDeg.toFixed(0)}°`);
    rollVal(`${telemetry.rollDeg >= 0 ? '+' : ''}${telemetry.rollDeg.toFixed(0)}°`);

    const horizon = `translateY(${-50 + telemetry.pitchDeg * 0.9}%) rotate(${-telemetry.rollDeg}deg)`;
    if (horizon !== lastHorizon) {
      lastHorizon = horizon;
      horizonLine.style.transform = horizon;
    }

    horizonTrim(telemetry.planeState === 'active');
    planeText(telemetry.planeLabel);
    if (telemetry.planeState !== lastPlaneState) {
      lastPlaneState = telemetry.planeState;
      planeEl.className = telemetry.planeState === 'idle' ? '' : telemetry.planeState === 'active' ? 'active' : 'noflow';
    }

    const manual = !telemetry.autoDepth;
    trimModeText(manual ? 'MANUAL TRIM' : 'AUTO DEPTH');
    trimModeMan(manual);

    const heel = Math.round(telemetry.heelDeg);
    heelVal(`${heel}°`);
    heelLimit(`${Math.round(telemetry.capsizeAngle)}°`);
    heelColor(
      telemetry.overLimit ? '#e8453c' : heel > telemetry.capsizeAngle * 0.7 ? '#f5b342' : '',
    );
    heelWarnShow((telemetry.overLimit && telemetry.alive) || telemetry.pumpsDead);
    heelWarnSmall(
      telemetry.pumpsDead ? 'Pumps dead — engines destroyed' : "Straighten up or you'll capsize",
    );

    depthVal(telemetry.depth.toFixed(1));
    subBadge(telemetry.submarine);
    enemyHull(String(telemetry.enemyHullPct));

    powVal(`${telemetry.powerPct}%`);
    elevVal(`${telemetry.elevDeg}°`);
    travVal(`${telemetry.travDeg >= 0 ? '+' : ''}${telemetry.travDeg}°`);
    rangeVal(telemetry.range === null ? '—' : `${Math.round(telemetry.range)}m`);

    reloadFillW(`${Math.round(telemetry.reloadPct * 100)}%`);
    reloadLabel(
      telemetry.reloadState === 'destroyed'
        ? 'Cannons Destroyed'
        : telemetry.reloadState === 'reloading'
          ? 'Reloading'
          : telemetry.reloadState === 'too-deep'
            ? 'Too Deep To Fire'
            : 'Weapon Ready',
    );
    reloadReady(telemetry.reloadState === 'ready');

    torpRowDisplay(telemetry.hasTorpedoes ? '' : 'none');
    if (telemetry.hasTorpedoes) {
      torpFillW(`${Math.round(telemetry.torpedoPct * 100)}%`);
      torpLabel(
        telemetry.torpedoState === 'reloading'
          ? 'Torpedo Reloading'
          : telemetry.torpedoState === 'too-shallow'
            ? 'Dive To Launch'
            : 'Torpedo Ready',
      );
      torpLabelColor(
        telemetry.torpedoState === 'reloading'
          ? '#8fa4ae'
          : telemetry.torpedoState === 'too-shallow'
            ? '#f5b342'
            : '#78dcbe',
      );
    }

    if (isTouch) {
      el('torpBtn').classList.toggle('show', telemetry.hasTorpedoes);
      el('trimPad').classList.toggle('show', telemetry.hasTanks);
      el('trimAuto').classList.toggle('man', manual);
    }
  };
  raf = requestAnimationFrame(tick);

  // ── controls ──
  const offs: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    node: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ) => {
    node.addEventListener(type, fn as EventListener, opts);
    offs.push(() => node.removeEventListener(type, fn as EventListener));
  };

  on(powSlider, 'input', () => game.setPower(Number(powSlider.value)));
  on(elevSlider, 'input', () => game.setElev(Number(elevSlider.value)));
  on(travSlider, 'input', () => game.setTrav(Number(travSlider.value)));

  // Keep sliders in step when the keyboard nudges the aim.
  const syncSliders = () => {
    const aim = game.input.aim;
    powSlider.value = String(Math.round(aim.power * 100));
    elevSlider.value = String(telemetry.elevDeg === 0 ? 0 : Math.round((aim.elev / (42 * Math.PI / 180)) * 100));
    travSlider.value = String(Math.round((aim.trav / (34 * Math.PI / 180)) * 100));
  };
  const sliderSync = setInterval(syncSliders, 100);
  offs.push(() => clearInterval(sliderSync));

  // Sliders and the palette must not also orbit the camera.
  for (const id of ['aimbar', 'palette']) {
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'mousedown'] as const) {
      on(el(id), ev, (e) => e.stopPropagation());
    }
  }

  // ── palette ──
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('.pbtn'))) {
    on(btn, 'click', () => {
      for (const b of Array.from(document.querySelectorAll('.pbtn'))) b.classList.remove('sel');
      btn.classList.add('sel');
      game.tool = (btn.dataset['type'] ?? 'hull') as BlockType | 'erase';
      btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  }

  // ── touch controls ──
  if (isTouch) bindTouchControls(game, on);

  // ── shipyard report ──
  function refreshShipReport(design: Design): void {
    const s = designStats(design);
    el('stBlocks').textContent = String(s.count);
    el('stMass').textContent = `${(s.mass / 1000).toFixed(1)} t`;
    el('stLift').textContent = s.liftRatio.toFixed(2);
    el('stEng').textContent = String(s.engines);
    el('stCan').textContent = String(s.cannons);
    el('stBal').textContent = String(s.ballast);
    el('stTorp').textContent = String(s.torps);
    el('stLight').textContent = String(s.lights);
    el('stAngle').textContent = s.count ? `${Math.round(s.capsizeAngle)}°` : '—';

    const vF = el('vFloat');
    if (s.count === 0) {
      vF.textContent = 'Empty Dock';
      vF.className = 'verdict bad';
    } else if (!s.connected) {
      vF.textContent = `⛔ ${s.orphans} Block(s) Not Attached`;
      vF.className = 'verdict bad';
    } else if (s.floats) {
      vF.textContent = '✓ Floats';
      vF.className = 'verdict good';
    } else {
      vF.textContent = '✗ Sinks!';
      vF.className = 'verdict bad';
    }

    const vD = el('vDive');
    if (s.canDive) {
      vD.textContent = '◈ Dive-Capable';
      vD.className = 'verdict good';
    } else if (s.ballast > 0) {
      vD.textContent = 'More Ballast To Dive';
      vD.className = 'verdict mid';
    } else {
      vD.textContent = 'No Dive Capability';
      vD.className = 'verdict mid';
    }

    // Balance bubble: top view, up = bow (+z), right = starboard (+x).
    const SCALE = 22; // px per block of centre-of-mass offset
    const dot = el('bbDot');
    dot.style.left = `calc(50% + ${clamp(s.offX * SCALE, -27, 27)}px)`;
    dot.style.top = `calc(50% - ${clamp(s.offZ * SCALE, -27, 27)}px)`;

    const tilt = Math.hypot(s.offX, s.offZ);
    const sideways = Math.abs(s.offX) > Math.abs(s.offZ);
    const notes: string[] = [];
    let severity = 0; // 0 ok, 1 warn, 2 bad

    if (tilt > 0.25) {
      severity = tilt > 0.7 ? 2 : 1;
      if (sideways) notes.push(s.offX > 0 ? 'Lists Starboard' : 'Lists Port');
      else notes.push(s.offZ > 0 ? 'Bow-Heavy' : 'Stern-Heavy');
    }
    if (s.count > 0 && s.capsizeRisk > 1.6) {
      severity = Math.max(severity, s.capsizeRisk > 2.2 ? 2 : 1);
      notes.push('Top-Heavy');
    }

    const vB = el('vBalance');
    const info = el('bbInfo');
    if (s.count === 0) {
      vB.textContent = '—';
      vB.className = 'verdict mid';
      info.textContent = '';
      dot.style.background = '#888';
    } else if (severity === 0) {
      vB.textContent = '✓ Stable';
      vB.className = 'verdict good';
      info.textContent = 'Balanced';
      dot.style.background = 'var(--ok)';
      dot.style.boxShadow = '0 0 7px rgba(125,220,138,0.7)';
    } else if (severity === 1) {
      vB.textContent = `⚠ ${notes.join(' · ')}`;
      vB.className = 'verdict warn';
      info.textContent = notes.join(', ');
      dot.style.background = 'var(--amber)';
      dot.style.boxShadow = '0 0 7px rgba(245,179,66,0.7)';
    } else {
      vB.textContent = `✗ ${notes.join(' · ')}`;
      vB.className = 'verdict bad';
      info.textContent = 'Will tip over!';
      dot.style.background = 'var(--danger)';
      dot.style.boxShadow = '0 0 7px rgba(232,69,60,0.8)';
    }

    const btn = el<HTMLButtonElement>('sailBtn');
    const missing: string[] = [];
    if (s.engines === 0) missing.push('no engine');
    if (s.cannons === 0) missing.push('no cannon');

    if (s.count === 0) {
      btn.disabled = true;
      btn.textContent = '⚓ Set Sail';
    } else if (!s.connected) {
      btn.disabled = true;
      btn.textContent = `⛔ ${s.orphans} Loose Block${s.orphans === 1 ? '' : 's'}`;
    } else {
      btn.disabled = false;
      btn.textContent = missing.length ? `⚓ Set Sail (${missing.join(', ')})` : '⚓ Set Sail';
    }
  }

  // ── mode + result ──
  let toastTimer: number | undefined;

  function setMode(mode: Mode): void {
    const build = mode === 'build';
    el('buildUI').classList.toggle('hidden', !build);
    el('battleUI').classList.toggle('hidden', build);
    el('battleStat').style.display = build ? 'none' : '';
    el('modeTag').textContent = build ? 'Shipyard' : 'Battle';
    el('toast').className = '';
    el('endBtns').classList.remove('show');
    el('centerbox').classList.remove('compact');
    el('heelWarn').classList.remove('show');
    clearTimeout(toastTimer);

    if (isTouch) {
      el('touch').style.display = build ? 'none' : 'block';
      if (!build) el('keys').style.display = 'none';
    }
  }

  function showResult(result: Result): void {
    const toast = el('toast');
    toast.textContent = result === 'win' ? 'Enemy Sunk' : 'You Sank';
    toast.className = `show ${result}`;
    el('endBtns').classList.add('show');
    // Slide it aside after a moment so it stops blocking the view.
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el('centerbox').classList.add('compact'), 2600);
  }

  return {
    setMode,
    showResult,
    refreshShipReport,
    dispose() {
      cancelAnimationFrame(raf);
      for (const off of offs) off();
    },
  };
}

type Binder = <K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  type: K,
  fn: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
) => void;

function bindTouchControls(game: Game, on: Binder): void {
  const input = game.input;

  // ── virtual joystick ──
  const joy = document.getElementById('joy');
  const nub = document.getElementById('joyNub');
  if (joy && nub) {
    const RADIUS = 46;
    let id: number | null = null;
    let cx = 0;
    let cy = 0;

    on(joy, 'touchstart', (e) => {
      const r = joy.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      id = e.changedTouches[0]?.identifier ?? null;
      e.preventDefault();
    });

    on(
      joy,
      'touchmove',
      (e) => {
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier !== id) continue;
          let dx = t.clientX - cx;
          let dy = t.clientY - cy;
          const d = Math.hypot(dx, dy);
          if (d > RADIUS) {
            dx *= RADIUS / d;
            dy *= RADIUS / d;
          }
          nub.style.transform = `translate(${dx}px,${dy}px)`;
          input.joyX = dx / RADIUS;
          input.joyY = dy / RADIUS;
        }
        e.preventDefault();
      },
      { passive: false },
    );

    const release = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== id) continue;
        id = null;
        input.joyX = 0;
        input.joyY = 0;
        nub.style.transform = 'translate(0,0)';
      }
    };
    on(joy, 'touchend', release);
    on(joy, 'touchcancel', release);
  }

  const tap = (id: string, fn: () => void) => {
    const node = document.getElementById(id);
    if (!node) return;
    on(node, 'touchstart', (e) => {
      e.preventDefault();
      fn();
    });
  };

  const hold = (id: string, set: (v: boolean) => void) => {
    const node = document.getElementById(id);
    if (!node) return;
    on(node, 'touchstart', (e) => {
      e.preventDefault();
      set(true);
    });
    on(node, 'touchend', () => set(false));
    on(node, 'touchcancel', () => set(false));
  };

  tap('fireBtn', () => game.firePlayerGun());
  tap('torpBtn', () => game.firePlayerTorpedo());
  tap('trimAuto', () => game.toggleAutoDepth());

  hold('floodBtn', (v) => (input.floodHeld = v));
  hold('blowBtn', (v) => (input.blowHeld = v));
  hold('trimUp', (v) => (input.trimHeld.up = v));
  hold('trimDown', (v) => (input.trimHeld.down = v));
  hold('trimLeft', (v) => (input.trimHeld.left = v));
  hold('trimRight', (v) => (input.trimHeld.right = v));
}
