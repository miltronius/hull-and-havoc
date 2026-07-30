/**
 * Underwater sunlight: god rays and Snell's window.
 *
 * Additive-blended, so it only ever *adds* light — which means it reads only
 * against a darker background. This is why the water material must not have an
 * emissive glow: an earlier attempt at brightening the underside of the surface
 * destroyed exactly the contrast this effect depends on.
 *
 * Lives in the top ~30 m and fades out below that.
 */

import * as THREE from 'three';

import { WATER_LEVEL } from '../constants';
import { waveHeight } from '../waves';

const SHAFT_H = 46;
const SHAFT_W = 15;
const BLADE_COUNT = 7;
/** Fully faded in by this depth, and gone again by {@link FADE_OUT_DEPTH}. */
const FADE_IN_DEPTH = 2.0;
const FADE_OUT_DEPTH = 30;

export interface GodRays {
  group: THREE.Group;
  /** @param camDepth metres of water above the camera; <= 0 means it is dry. */
  update(camX: number, camZ: number, camDepth: number, t: number, sunAngle: number): void;
}

function makeShaftTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;

  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  v.addColorStop(0.25, 'rgba(215,245,255,0.42)');
  v.addColorStop(0.65, 'rgba(180,230,255,0.13)');
  v.addColorStop(1.0, 'rgba(160,220,255,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 256);

  // Feather the vertical edges so each shaft has no hard sides.
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0.0, 'rgba(0,0,0,1)');
  h.addColorStop(0.5, 'rgba(0,0,0,0)');
  h.addColorStop(1.0, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 256);

  return new THREE.CanvasTexture(c);
}

export function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0.0, 'rgba(255,255,248,1)');
  r.addColorStop(0.12, 'rgba(255,250,225,0.92)');
  r.addColorStop(0.3, 'rgba(190,235,255,0.42)');
  r.addColorStop(0.55, 'rgba(140,210,255,0.12)');
  r.addColorStop(1.0, 'rgba(110,190,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export function createGodRays(scene: THREE.Scene): GodRays {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  const shaftMat = new THREE.MeshBasicMaterial({
    map: makeShaftTexture(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

  const shaftGeo = new THREE.PlaneGeometry(SHAFT_W, SHAFT_H);
  shaftGeo.translate(0, -SHAFT_H / 2, 0); // hangs down from the surface

  // Each blade keeps its own phase and base width so the fan shimmers
  // unevenly rather than pulsing as one. Tracked alongside the mesh rather
  // than stuffed into `userData`, which is untyped.
  interface Blade {
    mesh: THREE.Mesh;
    phase: number;
    baseX: number;
  }

  const blades: Blade[] = [];
  for (let i = 0; i < BLADE_COUNT; i++) {
    const mesh = new THREE.Mesh(shaftGeo, shaftMat);
    mesh.rotation.y = (i / BLADE_COUNT) * Math.PI;
    mesh.rotation.z = (Math.random() - 0.5) * 0.22;
    group.add(mesh);
    blades.push({ mesh, phase: Math.random() * Math.PI * 2, baseX: 0.75 + Math.random() * 0.6 });
  }

  const glowMat = new THREE.MeshBasicMaterial({
    map: makeGlowTexture(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(58, 58), glowMat);
  glow.rotation.x = -Math.PI / 2; // flat under the surface, seen from below
  glow.renderOrder = 3;
  group.add(glow);

  return {
    group,
    update(camX, camZ, camDepth, t, sunAngle) {
      const vis =
        camDepth > 0
          ? Math.min(1, camDepth / FADE_IN_DEPTH) * Math.max(0, 1 - camDepth / FADE_OUT_DEPTH)
          : 0;

      group.visible = vis > 0.01;
      if (!group.visible) return;

      const surfHere = WATER_LEVEL + waveHeight(camX, camZ, t);
      group.position.set(camX, surfHere, camZ);
      // Keep the window just under the surface, or the water plane occludes it.
      glow.position.y = -1.1;
      group.rotation.y = sunAngle + Math.sin(t * 0.12) * 0.12;

      shaftMat.opacity = 0.7 * vis;
      glowMat.opacity = Math.min(1, 1.6 * vis);

      // Shimmer: each blade breathes at its own pace.
      for (const bl of blades) {
        bl.mesh.scale.x = bl.baseX * (1 + Math.sin(t * 1.3 + bl.phase) * 0.28);
      }
      glow.scale.setScalar(1 + Math.sin(t * 0.8) * 0.06);
    },
  };
}
