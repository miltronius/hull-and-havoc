/**
 * The visible ocean: wave mesh, procedural ripple normal map, the underwater
 * tint volume, and the seabed.
 *
 * The wave *shape* is not defined here — it comes from `engine/waves.ts`, the
 * same pure function buoyancy and the camera sample. Keeping one source for it
 * is what stops the water you see drifting apart from the water the physics
 * uses.
 */

import * as THREE from 'three';

import { SEABED } from '../constants';
import { waveHeight } from '../waves';

export const OCEAN_SIZE = 1200;
const SEGMENTS = 110;

export interface Ocean {
  water: THREE.Mesh;
  /** The underwater tint volume — visible only from below. */
  deep: THREE.Mesh;
  seabed: THREE.Mesh;
  rippleMap: THREE.Texture;
  update(focusX: number, focusZ: number, t: number): void;
}

/**
 * A tileable ripple normal map, generated at runtime.
 *
 * Built on a canvas rather than shipped as an image so the project stays
 * asset-free — the original opened straight from `file://` with no server.
 */
function makeRippleNormalMap(size: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);

  const H = (i: number, j: number) => {
    const u = (i / size) * Math.PI * 2;
    const v = (j / size) * Math.PI * 2;
    return (
      Math.sin(u * 3 + Math.cos(v * 2)) * 0.5 +
      Math.sin(v * 4 - Math.cos(u * 3)) * 0.35 +
      Math.sin((u + v) * 6) * 0.15
    );
  };

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Wrap the sampling so the map tiles seamlessly.
      const w = (a: number, b: number) => H((a + size) % size, (b + size) % size);
      const dx = w(i + 1, j) - w(i - 1, j);
      const dy = w(i, j + 1) - w(i, j - 1);
      const nx = -dx * 1.6;
      const ny = -dy * 1.6;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const o = (j * size + i) * 4;
      img.data[o] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[o + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[o + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(26, 26);
  return tex;
}

export function createOcean(scene: THREE.Scene): Ocean {
  const waterGeo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, SEGMENTS, SEGMENTS);
  waterGeo.rotateX(-Math.PI / 2);

  const rippleMap = makeRippleNormalMap(128);
  const water = new THREE.Mesh(
    waterGeo,
    new THREE.MeshStandardMaterial({
      color: 0x2c7a96,
      metalness: 0.16,
      roughness: 0.38,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      normalMap: rippleMap,
      normalScale: new THREE.Vector2(0.32, 0.32),
      // Deliberately NO emissive. The underside must stay dark, or the
      // additive Snell's window and god rays have nothing to read against —
      // an earlier attempt at an emissive glow killed the effect outright.
    }),
  );
  water.receiveShadow = true;
  scene.add(water);

  // Grab the attribute once: `geometry.attributes` is an index signature, so
  // reaching through it repeatedly fights `noUncheckedIndexedAccess`.
  const waterPos = waterGeo.getAttribute('position') as THREE.BufferAttribute;
  const pos = waterPos.array as unknown as number[];
  /** Undisplaced vertex positions, the basis for every frame's wave field. */
  const basePos = Float32Array.from(pos);

  const deep = new THREE.Mesh(
    new THREE.BoxGeometry(OCEAN_SIZE, 420, OCEAN_SIZE),
    new THREE.MeshBasicMaterial({
      color: 0x0a3247,
      transparent: true,
      opacity: 0.18,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  deep.position.y = -213; // lid sits at -3, below the deepest wave trough
  scene.add(deep);

  // ── seabed ──
  const bedGeo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 48, 48);
  bedGeo.rotateX(-Math.PI / 2);
  const bp = (bedGeo.getAttribute('position') as THREE.BufferAttribute)
    .array as unknown as number[];
  for (let i = 0; i < bp.length; i += 3) {
    bp[i + 1] =
      (Math.sin(bp[i]! * 0.03) + Math.cos(bp[i + 2]! * 0.025)) * 2.2 +
      Math.sin(bp[i]! * 0.11 + bp[i + 2]! * 0.07) * 0.8;
  }
  bedGeo.computeVertexNormals();

  const seabed = new THREE.Mesh(
    bedGeo,
    new THREE.MeshStandardMaterial({ color: 0x2e3d33, roughness: 1, flatShading: true }),
  );
  seabed.position.y = SEABED;
  scene.add(seabed);

  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x3a4a40,
    roughness: 1,
    flatShading: true,
  });
  for (let i = 0; i < 24; i++) {
    const r = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2 + Math.random() * 5, 0),
      rockMat,
    );
    r.position.set((Math.random() - 0.5) * 500, SEABED + 1, (Math.random() - 0.5) * 500);
    r.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    scene.add(r);
  }

  return {
    water,
    deep,
    seabed,
    rippleMap,
    update(focusX, focusZ, t) {
      // Move the sheet FIRST, then build the waves from world coordinates.
      // Computing heights from the mesh's local vertex positions before
      // translating it made the visible surface drift out of step with the
      // physics surface the further you sailed from the origin.
      water.position.x = focusX;
      water.position.z = focusZ;
      deep.position.x = focusX;
      deep.position.z = focusZ;

      for (let i = 0; i < pos.length; i += 3) {
        pos[i + 1] = waveHeight(basePos[i]! + focusX, basePos[i + 2]! + focusZ, t);
      }
      waterPos.needsUpdate = true;
      waterGeo.computeVertexNormals();
      rippleMap.offset.set(t * 0.006, t * 0.004);
    },
  };
}
