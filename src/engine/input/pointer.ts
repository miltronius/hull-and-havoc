/**
 * Orbit camera and tap-to-edit, for mouse and touch alike.
 *
 * The awkward part is telling a *tap* from a *drag* on one pointer, and then
 * stopping mobile browsers from acting on the tap twice. Both fixes below were
 * found the hard way:
 *
 * - Mobile fires synthetic mouse events after `touchend`, which placed a second
 *   block on every tap. Suppressed with a 700 ms window after any touch, plus a
 *   120 ms debounce inside `tryEdit` as a backstop.
 * - A pointer that moved more than a few pixels is an orbit, not a tap.
 */

import { clamp } from '../math';
import { CAMERA_LIMITS, type InputState } from './state';

/** Pixels of travel below which a pointer gesture still counts as a tap. */
const TAP_SLOP = 7;
/** Mouse events within this long after a touch are the browser's synthetics. */
const SYNTHETIC_MOUSE_WINDOW = 700;

export interface PointerOptions {
  /** Called on a tap. Coordinates are client-space. */
  onTap(clientX: number, clientY: number): void;
}

export function bindPointer(
  canvas: HTMLCanvasElement,
  input: InputState,
  options: PointerOptions,
): () => void {
  const cam = input.camera;

  let dragId: number | null = null;
  let pinchId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let moved = 0;
  let pinchStart = 0;
  let distStart = 0;
  let lastTouchEnd = 0;

  const isSyntheticMouse = () => performance.now() - lastTouchEnd < SYNTHETIC_MOUSE_WINDOW;

  // ── touch ──
  const onTouchStart = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (dragId === null) {
        dragId = t.identifier;
        lastX = t.clientX;
        lastY = t.clientY;
        moved = 0;
      } else if (pinchId === null) {
        pinchId = t.identifier;
        const a = Array.from(e.touches).find((x) => x.identifier === dragId);
        if (a) {
          pinchStart = Math.hypot(t.clientX - a.clientX, t.clientY - a.clientY);
          distStart = cam.dist;
        }
      }
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if (pinchId !== null) {
      const a = Array.from(e.touches).find((x) => x.identifier === dragId);
      const b = Array.from(e.touches).find((x) => x.identifier === pinchId);
      if (a && b && pinchStart > 0) {
        const d = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        cam.dist = clamp(
          distStart * (pinchStart / d),
          CAMERA_LIMITS.minDist,
          CAMERA_LIMITS.maxDist,
        );
      }
      return;
    }
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== dragId) continue;
      moved += Math.abs(t.clientX - lastX) + Math.abs(t.clientY - lastY);
      cam.yaw -= (t.clientX - lastX) * 0.006;
      cam.pitch = clamp(
        cam.pitch + (t.clientY - lastY) * 0.005,
        CAMERA_LIMITS.minPitch,
        CAMERA_LIMITS.maxPitch,
      );
      lastX = t.clientX;
      lastY = t.clientY;
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === dragId) {
        if (moved < TAP_SLOP) options.onTap(t.clientX, t.clientY);
        dragId = null;
      }
      if (t.identifier === pinchId) pinchId = null;
    }
    if (e.touches.length === 0) {
      dragId = null;
      pinchId = null;
    }
    lastTouchEnd = performance.now();
    // Stop the browser's synthetic mouse events, which would place a 2nd block.
    if (e.cancelable) e.preventDefault();
  };

  // ── mouse ──
  let mouseDown = false;
  let mouseMoved = 0;

  const onMouseDown = (e: MouseEvent) => {
    if (isSyntheticMouse()) return;
    mouseDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    mouseMoved = 0;
  };

  const onMouseUp = (e: MouseEvent) => {
    if (isSyntheticMouse()) {
      mouseDown = false;
      return;
    }
    if (mouseDown && mouseMoved < TAP_SLOP) options.onTap(e.clientX, e.clientY);
    mouseDown = false;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!mouseDown) return;
    mouseMoved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    cam.yaw -= (e.clientX - lastX) * 0.005;
    cam.pitch = clamp(
      cam.pitch + (e.clientY - lastY) * 0.004,
      CAMERA_LIMITS.minPitch,
      CAMERA_LIMITS.maxPitch,
    );
    lastX = e.clientX;
    lastY = e.clientY;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    cam.dist = clamp(
      cam.dist + e.deltaY * 0.02,
      CAMERA_LIMITS.minDist,
      CAMERA_LIMITS.maxDist,
    );
  };

  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: true });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchEnd);
  canvas.addEventListener('mousedown', onMouseDown);
  addEventListener('mouseup', onMouseUp);
  addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', onTouchMove);
    canvas.removeEventListener('touchend', onTouchEnd);
    canvas.removeEventListener('touchcancel', onTouchEnd);
    canvas.removeEventListener('mousedown', onMouseDown);
    removeEventListener('mouseup', onMouseUp);
    removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('wheel', onWheel);
  };
}
