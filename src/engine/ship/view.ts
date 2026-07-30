/**
 * The visual half of a compiled ship.
 *
 * `compiler.ts` builds the physics; this builds the meshes, lamps and dive
 * planes and keeps them in step with the body. The split is what lets the
 * simulation run headlessly in Node — see `tests/physics.test.ts`.
 *
 * Views are held in a `Map` keyed by `Ship` rather than as a field on the ship
 * itself, so the physics object never carries a renderer reference at all.
 */

import * as THREE from 'three';

import { B, MAX_LIVE_LIGHTS } from '../constants';
import type { Ship, ShipBlock } from '../types';
import { blockMesh, type BlockMesh } from './blocks';
import { makeGlowTexture } from '../scene/godrays';

export interface BlockView {
  mesh: BlockMesh;
  light: THREE.PointLight | null;
  halo: THREE.Sprite | null;
}

export interface ShipView {
  group: THREE.Group;
  blocks: Map<ShipBlock, BlockView>;
  /** Stern dive planes — visible proof that trim input is doing something. */
  planes: THREE.Group | null;
}

/** One shared halo texture; every lamp on every ship reuses it. */
let haloTexture: THREE.Texture | null = null;
function getHaloTexture(): THREE.Texture {
  haloTexture ??= makeGlowTexture();
  return haloTexture;
}

export function attachShipView(scene: THREE.Scene, ship: Ship): ShipView {
  const group = new THREE.Group();
  scene.add(group);

  const blocks = new Map<ShipBlock, BlockView>();

  for (const blk of ship.blocks) {
    const mesh = blockMesh(blk.type);
    mesh.position.set(blk.local.x, blk.local.y, blk.local.z);
    group.add(mesh);
    blocks.set(blk, { mesh, light: null, halo: null });
  }

  // Real point lights are expensive, so only the first few lamps get one.
  let lit = 0;
  for (const blk of ship.blocks) {
    if (!blk.isLight || lit >= MAX_LIVE_LIGHTS) continue;
    const view = blocks.get(blk)!;

    const pl = new THREE.PointLight(0xffe9b0, 0, 85, 1.0);
    pl.position.set(blk.local.x, blk.local.y + 0.1, blk.local.z + B * 0.5);
    group.add(pl);
    view.light = pl;

    // A glowing halo around the lens, so the lamp visibly reads as lit even
    // when its cone is not falling on anything.
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: getHaloTexture(),
        color: 0xffe9b0,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    halo.scale.setScalar(5.5);
    halo.position.copy(pl.position);
    group.add(halo);
    view.halo = halo;

    lit++;
  }

  // ── stern dive planes ──
  let planes: THREE.Group | null = null;
  if (ship.ballastTanks > 0) {
    let minZ = Infinity;
    let avgY = 0;
    for (const blk of ship.blocks) {
      minZ = Math.min(minZ, blk.local.z);
      avgY += blk.local.y;
    }
    avgY = ship.blocks.length ? avgY / ship.blocks.length : 0;

    planes = new THREE.Group();
    planes.position.set(0, avgY, minZ - B * 0.35);
    const finMat = new THREE.MeshStandardMaterial({
      color: 0x8a97a3,
      metalness: 0.5,
      roughness: 0.5,
      flatShading: true,
    });
    for (const sgn of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(B * 1.15, 0.12, B * 0.62), finMat);
      fin.position.set(sgn * B * 0.95, 0, 0);
      fin.castShadow = true;
      planes.add(fin);
    }
    group.add(planes);
  }

  return { group, blocks, planes };
}

/** Copy the physics transform onto the meshes. Called once per frame. */
export function syncShipView(ship: Ship, view: ShipView): void {
  view.group.position.copy(ship.body.position as unknown as THREE.Vector3);
  view.group.quaternion.copy(ship.body.quaternion as unknown as THREE.Quaternion);
}

/** Detach a destroyed block's visuals. The physics side is `destroyBlock`. */
export function removeBlockView(view: ShipView, blk: ShipBlock): void {
  const bv = view.blocks.get(blk);
  if (!bv) return;
  view.group.remove(bv.mesh);
  if (bv.light) {
    view.group.remove(bv.light);
    bv.light = null;
  }
  if (bv.halo) {
    view.group.remove(bv.halo);
    bv.halo = null;
  }
}

/** Drop the visuals of anything that died since the last frame. */
export function reapDeadBlocks(ship: Ship, view: ShipView): void {
  for (const blk of ship.blocks) {
    if (!blk.alive && view.blocks.get(blk)?.mesh.parent) removeBlockView(view, blk);
  }
}

/**
 * Lamps brighten as the water darkens.
 *
 * @param lampDepth 0 at the surface, 1 in full darkness.
 */
export function updateLamps(view: ShipView, lampDepth: number): void {
  for (const bv of view.blocks.values()) {
    if (bv.light) bv.light.intensity = 0.3 + lampDepth * 6.5;
    if (bv.halo) bv.halo.material.opacity = 0.12 + lampDepth * 0.8;
  }
}

/** Deflect the dive planes toward the current trim command. */
export function updatePlanes(ship: Ship, view: ShipView, dt: number): void {
  if (!view.planes) return;
  const wantX = -ship.trimCmd.pitch * 0.55;
  const wantZ = ship.trimCmd.roll * 0.35;
  const k = Math.min(1, dt * 9);
  view.planes.rotation.x += (wantX - view.planes.rotation.x) * k;
  view.planes.rotation.z += (wantZ - view.planes.rotation.z) * k;
}

/** Point every live barrel at the given elevation and traverse. */
export function aimBarrels(ship: Ship, view: ShipView, elev: number, trav: number): void {
  for (const blk of ship.blocks) {
    if (!blk.alive || !blk.isCannon) continue;
    const ud = view.blocks.get(blk)?.mesh.userData;
    if (!ud) continue;
    if (ud.traversePivot) ud.traversePivot.rotation.y = trav;
    if (ud.elevPivot) ud.elevPivot.rotation.x = -elev;
  }
}

export function disposeShipView(scene: THREE.Scene, view: ShipView): void {
  scene.remove(view.group);
  view.blocks.clear();
}
