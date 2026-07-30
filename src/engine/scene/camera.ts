/**
 * Chase camera and depth-driven lighting.
 *
 * Two collision fixes here are not optional:
 *
 * 1. **Never below the seabed.** The bed mesh bumps up ~3 m from its base, so
 *    the floor is `SEABED + 5`, not `SEABED`.
 * 2. **Never coplanar with the water.** Sitting exactly in the surface plane
 *    sliced the view in half, so the camera is pushed out of a small band
 *    around the live wave height — above it or below it, but never in it.
 */

import * as THREE from 'three';

import { DARK_DEPTH, SEABED, WATER_LEVEL } from '../constants';
import { clamp } from '../math';
import { waveHeight } from '../waves';
import type { OrbitCamera } from '../input/state';
import { SURFACE_FOG, SURFACE_LIGHT, type Stage } from './renderer';

/** Half-thickness of the forbidden band around the water plane. */
const SURFACE_BAND = 0.7;
const SEABED_MARGIN = 5;

const _target = new THREE.Vector3();
const _want = new THREE.Vector3();
const _deepColor = new THREE.Color();
const SHALLOW = new THREE.Color(0x1b5470);
const ABYSS = new THREE.Color(0x000205);

export interface CameraTarget {
  x: number;
  y: number;
  z: number;
  /** Hull heading in radians; the orbit yaw is relative to it. */
  heading: number;
}

/** Follow the target, smoothly, then clamp out of geometry. */
export function updateCamera(
  stage: Stage,
  orbit: OrbitCamera,
  target: CameraTarget,
  dt: number,
  t: number,
): void {
  _target.set(target.x, target.y, target.z);

  const ang = target.heading + orbit.yaw;
  const horiz = Math.cos(orbit.pitch) * orbit.dist;
  const vert = Math.sin(orbit.pitch) * orbit.dist;

  _want.set(
    _target.x - Math.sin(ang) * horiz,
    _target.y + vert + 0.5,
    _target.z - Math.cos(ang) * horiz,
  );
  // Frame-rate independent smoothing.
  stage.camera.position.lerp(_want, 1 - Math.pow(0.0015, dt));

  const bedTop = SEABED + SEABED_MARGIN;
  if (stage.camera.position.y < bedTop) stage.camera.position.y = bedTop;

  const camSurf =
    WATER_LEVEL + waveHeight(stage.camera.position.x, stage.camera.position.z, t);
  const dSurf = stage.camera.position.y - camSurf;
  if (Math.abs(dSurf) < SURFACE_BAND) {
    stage.camera.position.y = camSurf + (dSurf >= 0 ? SURFACE_BAND : -SURFACE_BAND);
  }

  stage.camera.lookAt(_target);
}

/** Metres of water above the camera. Negative means it is in the air. */
export function cameraDepth(stage: Stage, t: number): number {
  const surf = WATER_LEVEL + waveHeight(stage.camera.position.x, stage.camera.position.z, t);
  return surf - stage.camera.position.y;
}

/**
 * Fade the world toward black as the camera descends.
 *
 * Murky rather than opaque — you can still make out your own hull at depth,
 * which is what makes the lamps worth building.
 */
export function applyDepthLighting(stage: Stage, camDepth: number): void {
  if (camDepth > 0) {
    const f = clamp(camDepth / DARK_DEPTH, 0, 1);
    _deepColor.copy(SHALLOW).lerp(ABYSS, Math.pow(f, 0.7));
    stage.fog.color.copy(_deepColor);
    stage.fog.density = 0.012 + f * 0.026;
    stage.renderer.setClearColor(_deepColor);
    stage.sun.intensity = SURFACE_LIGHT.sun * Math.max(0, 1 - f * 1.15);
    stage.hemi.intensity = SURFACE_LIGHT.hemi * Math.max(0.02, 1 - f * 1.2);
    stage.amb.intensity = SURFACE_LIGHT.amb * Math.max(0.03, 1 - f * 1.1);
  } else {
    stage.fog.color.setHex(SURFACE_FOG.color);
    stage.fog.density = SURFACE_FOG.density;
    stage.renderer.setClearColor(SURFACE_FOG.color);
    stage.sun.intensity = SURFACE_LIGHT.sun;
    stage.hemi.intensity = SURFACE_LIGHT.hemi;
    stage.amb.intensity = SURFACE_LIGHT.amb;
  }
}

/** 0 at the surface, 1 in full darkness — drives lamp brightness. */
export function lampDepthFactor(camDepth: number): number {
  return clamp(camDepth / 25, 0, 1);
}
