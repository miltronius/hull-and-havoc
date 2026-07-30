/**
 * The shipyard: the editable grid, its mesh preview, and tap-to-place.
 *
 * The design itself is a plain `Map` (see `ship/design.ts`); this module is
 * only its visual representation and the raycasting that edits it.
 */

import * as THREE from 'three';

import { B, GRID_H, GRID_R, HB } from '../constants';
import { blockMesh, type BlockMesh } from '../ship/blocks';
import { connectivity, key, parseKey } from '../ship/design';
import type { BlockType, Design } from '../types';

/** Never place two blocks from a single tap. */
const EDIT_DEBOUNCE_MS = 120;

export type Tool = BlockType | 'erase';

export interface BuildView {
  group: THREE.Group;
  grid: THREE.GridHelper;
  /** Invisible plane used to place the first block on an empty dock. */
  groundPlane: THREE.Mesh;
  meshes: Map<string, BlockMesh>;
  setVisible(v: boolean): void;
  rebuild(design: Design): void;
}

export function createBuildView(scene: THREE.Scene): BuildView {
  const group = new THREE.Group();
  scene.add(group);

  const grid = new THREE.GridHelper(
    (GRID_R * 2 + 1) * B,
    GRID_R * 2 + 1,
    0x6fd0e0,
    0x2a4a5a,
  );
  grid.position.y = 0.01;
  scene.add(grid);

  const groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry((GRID_R * 2 + 1) * B, (GRID_R * 2 + 1) * B),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  groundPlane.rotateX(-Math.PI / 2);
  scene.add(groundPlane);

  const meshes = new Map<string, BlockMesh>();

  return {
    group,
    grid,
    groundPlane,
    meshes,

    setVisible(v) {
      group.visible = v;
      grid.visible = v;
    },

    rebuild(design) {
      for (const m of meshes.values()) group.remove(m);
      meshes.clear();

      const conn = connectivity(design);
      design.forEach((type, k) => {
        const [x, y, z] = parseKey(k);
        const m = blockMesh(type);
        m.position.set(x * B, y * B + HB, z * B);
        m.userData.gridKey = k;

        // Orphaned blocks glow red, so the player can see what to fix rather
        // than just being told the ship will not sail.
        if (!conn.set.has(k)) {
          const mat = m.userData.core.material;
          mat.emissive = new THREE.Color(0xe8453c);
          mat.emissiveIntensity = 0.6;
          mat.transparent = true;
          mat.opacity = 0.75;
        }

        group.add(m);
        meshes.set(k, m);
      });
    },
  };
}

export interface Editor {
  /** @returns true if the design changed. */
  tryEdit(clientX: number, clientY: number, design: Design, tool: Tool): boolean;
}

export function createEditor(view: BuildView, camera: THREE.Camera): Editor {
  const raycaster = new THREE.Raycaster();
  let lastEditAt = 0;

  const inBounds = (x: number, y: number, z: number) =>
    Math.abs(x) <= GRID_R && Math.abs(z) <= GRID_R && y >= 0 && y <= GRID_H;

  return {
    tryEdit(clientX, clientY, design, tool) {
      const now = performance.now();
      if (now - lastEditAt < EDIT_DEBOUNCE_MS) return false;
      lastEditAt = now;

      const ndc = new THREE.Vector2(
        (clientX / innerWidth) * 2 - 1,
        -(clientY / innerHeight) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);

      const cores = [...view.meshes.values()].map((g) => g.userData.core);
      const blockHits = raycaster.intersectObjects(cores);

      if (blockHits.length > 0) {
        const hit = blockHits[0]!;
        const parent = hit.object.parent as BlockMesh | null;
        const k = parent?.userData.gridKey;
        if (!k) return false;

        if (tool === 'erase') {
          design.delete(k);
          return true;
        }

        // Place adjacent, in the direction of the face that was tapped.
        if (!hit.face) return false;
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).round();
        const [x, y, z] = parseKey(k);
        const nx = x + n.x;
        const ny = y + n.y;
        const nz = z + n.z;

        if (inBounds(nx, ny, nz) && !design.has(key(nx, ny, nz))) {
          design.set(key(nx, ny, nz), tool);
          return true;
        }
        return false;
      }

      // Empty dock: drop the block on layer 0 where the ground was tapped.
      if (tool === 'erase') return false;
      const groundHit = raycaster.intersectObject(view.groundPlane);
      if (groundHit.length === 0) return false;

      const p = groundHit[0]!.point;
      const gx = Math.round(p.x / B);
      const gz = Math.round(p.z / B);
      if (inBounds(gx, 0, gz) && !design.has(key(gx, 0, gz))) {
        design.set(key(gx, 0, gz), tool);
        return true;
      }
      return false;
    },
  };
}
