/**
 * The targeting reticle.
 *
 * Positioned from `predictImpact` — the same function that gives the shell its
 * velocity — so the ring genuinely marks where the round will land rather than
 * approximating it.
 */

import * as THREE from 'three';

export interface Reticle {
  group: THREE.Group;
  setVisible(v: boolean): void;
  place(x: number, y: number, z: number, t: number): void;
  /** Green when the shot would land on an enemy, amber otherwise. */
  setOnTarget(on: boolean): void;
}

export function createReticle(scene: THREE.Scene): Reticle {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xf5b342,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    // Drawn over everything, so it stays readable against a dark hull.
    depthTest: false,
  });

  const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.1, 36), mat);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const inner = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.85, 24), mat);
  inner.rotation.x = -Math.PI / 2;
  group.add(inner);

  for (let i = 0; i < 4; i++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 1.0), mat);
    tick.rotation.x = -Math.PI / 2;
    tick.rotation.z = (i * Math.PI) / 2;
    tick.position.set(Math.sin((i * Math.PI) / 2) * 2.7, 0, Math.cos((i * Math.PI) / 2) * 2.7);
    group.add(tick);
  }

  group.renderOrder = 999;
  group.visible = false;
  scene.add(group);

  return {
    group,
    setVisible(v) {
      group.visible = v;
    },
    place(x, y, z, t) {
      group.position.set(x, y + 0.15, z);
      group.scale.setScalar(1 + Math.sin(t * 4) * 0.04);
    },
    setOnTarget(on) {
      mat.color.setHex(on ? 0x7ddc8a : 0xf5b342);
    },
  };
}
