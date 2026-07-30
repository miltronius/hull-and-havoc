/**
 * Mesh bookkeeping for shells and torpedoes.
 *
 * The projectiles themselves are plain data in `combat/weapons.ts`, with no
 * renderer reference. This module walks those arrays each frame, creating a
 * mesh for anything new and dropping meshes for anything that has been spliced
 * out — the same pattern as `ship/view.ts`.
 */

import * as THREE from 'three';

import type { Combat, Shell, Torpedo } from '../combat/weapons';

export interface ProjectileViews {
  sync(combat: Combat): void;
  clear(): void;
}

export function createProjectileViews(scene: THREE.Scene): ProjectileViews {
  const shellMeshes = new Map<Shell, THREE.Mesh>();
  const torpMeshes = new Map<Torpedo, THREE.Group>();

  const shellGeo = new THREE.SphereGeometry(0.32, 10, 10);
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xffd27f,
    emissive: 0xff8a2a,
    emissiveIntensity: 0.8,
    metalness: 0.5,
    roughness: 0.3,
  });

  const torpGeo = new THREE.CylinderGeometry(0.22, 0.22, 1.7, 10);
  const torpMat = new THREE.MeshStandardMaterial({
    color: 0xd8e4e0,
    metalness: 0.5,
    roughness: 0.4,
  });

  function reap<T, M extends THREE.Object3D>(live: readonly T[], meshes: Map<T, M>) {
    if (meshes.size === live.length) return;
    const alive = new Set(live);
    for (const [key, mesh] of meshes) {
      if (!alive.has(key)) {
        scene.remove(mesh);
        meshes.delete(key);
      }
    }
  }

  return {
    sync(combat) {
      for (const sh of combat.shells) {
        let mesh = shellMeshes.get(sh);
        if (!mesh) {
          mesh = new THREE.Mesh(shellGeo, shellMat);
          mesh.castShadow = true;
          scene.add(mesh);
          shellMeshes.set(sh, mesh);
        }
        mesh.position.set(sh.pos.x, sh.pos.y, sh.pos.z);
      }
      reap(combat.shells, shellMeshes);

      for (const tp of combat.torpedoes) {
        let holder = torpMeshes.get(tp);
        if (!holder) {
          const body = new THREE.Mesh(torpGeo, torpMat);
          body.rotation.x = Math.PI / 2; // lay the cylinder along its run
          holder = new THREE.Group();
          holder.add(body);
          scene.add(holder);
          torpMeshes.set(tp, holder);
        }
        holder.position.set(tp.pos.x, tp.pos.y, tp.pos.z);
        holder.lookAt(tp.pos.x + tp.dir.x, tp.pos.y, tp.pos.z + tp.dir.z);
      }
      reap(combat.torpedoes, torpMeshes);
    },

    clear() {
      for (const m of shellMeshes.values()) scene.remove(m);
      for (const m of torpMeshes.values()) scene.remove(m);
      shellMeshes.clear();
      torpMeshes.clear();
    },
  };
}
