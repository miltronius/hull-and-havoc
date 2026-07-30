/**
 * Block meshes.
 *
 * One group per block: a shaded core cube plus whatever hardware the type
 * carries. Cannons get a two-stage pivot so the barrel can traverse and
 * elevate independently — the HUD drives those directly from the player's aim,
 * which is what makes the gun visibly point where the reticle is.
 */

import * as THREE from 'three';

import { B, BLOCKS } from '../constants';
import type { BlockType } from '../types';

export interface BlockMeshData {
  /** The cube itself. Raycast against this for build-mode placement. */
  core: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  /** Cannon only: yaw pivot. */
  traversePivot?: THREE.Group;
  /** Cannon only: pitch pivot, nested inside the traverse pivot. */
  elevPivot?: THREE.Group;
  /** Light only. */
  lens?: THREE.Mesh;
  /** Build mode only: which grid cell this mesh represents. */
  gridKey?: string;
}

export type BlockMesh = THREE.Group & { userData: BlockMeshData };

export function blockMesh(type: BlockType): BlockMesh {
  const def = BLOCKS[type];
  const g = new THREE.Group() as BlockMesh;

  const core = new THREE.Mesh(
    new THREE.BoxGeometry(B * 0.98, B * 0.98, B * 0.98),
    new THREE.MeshStandardMaterial({
      color: def.color,
      metalness: 0.35,
      roughness: 0.55,
      flatShading: true,
    }),
  );
  core.castShadow = true;
  core.receiveShadow = true;
  g.add(core);

  if (type === 'cannon') {
    const pivot = new THREE.Group();
    pivot.position.set(0, 0.15, 0);
    const elevPivot = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.17, B * 1.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.6, roughness: 0.4 }),
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, B * 0.7);
    elevPivot.add(barrel);
    pivot.add(elevPivot);
    g.add(pivot);
    g.userData.traversePivot = pivot;
    g.userData.elevPivot = elevPivot;
  }

  if (type === 'light') {
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.16, 14),
      new THREE.MeshStandardMaterial({
        color: 0xfff6d0,
        emissive: 0xffe9a8,
        emissiveIntensity: 1.4,
      }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.1, B * 0.5);
    g.add(lens);
    g.userData.lens = lens;
  }

  if (type === 'torpedo') {
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, B * 0.95, 12),
      new THREE.MeshStandardMaterial({ color: 0x1b3d36, metalness: 0.55, roughness: 0.5 }),
    );
    tube.rotation.x = Math.PI / 2;
    tube.position.set(0, -0.1, B * 0.35);
    g.add(tube);
  }

  if (type === 'engine') {
    const pipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.22, 0.7, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 }),
    );
    pipe.position.set(0, B * 0.6, 0);
    g.add(pipe);
  }

  g.userData.core = core;
  return g;
}
