/**
 * Three.js implementation of the {@link Effects} seam.
 *
 * Particles and debris are pure decoration — they never touch the physics
 * world, they just fall under their own arithmetic and fade out. Keeping them
 * behind the interface is what lets combat run headlessly in tests.
 */

import * as THREE from 'three';

import { B, G, WATER_LEVEL } from '../constants';
import type { Effects } from '../combat/effects';
import { waveHeight } from '../waves';

interface Particle {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  vel: THREE.Vector3;
  life: number;
}

interface DebrisChunk {
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

export interface SceneEffects extends Effects {
  update(dt: number, t: number): void;
  clear(): void;
}

export function createEffects(scene: THREE.Scene): SceneEffects {
  const particles: Particle[] = [];
  const debris: DebrisChunk[] = [];
  const partGeo = new THREE.SphereGeometry(0.18, 6, 6);
  const debrisGeo = new THREE.BoxGeometry(B * 0.5, B * 0.5, B * 0.5);

  return {
    splash(x, y, z, color, count, spread) {
      for (let i = 0; i < count; i++) {
        const mesh = new THREE.Mesh(
          partGeo,
          new THREE.MeshBasicMaterial({ color, transparent: true }),
        );
        mesh.position.set(x, y, z);
        scene.add(mesh);
        particles.push({
          mesh,
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * spread * 10,
            Math.random() * spread * 8 + 2,
            (Math.random() - 0.5) * spread * 10,
          ),
          life: 0.9 + Math.random() * 0.5,
        });
      }
    },

    debris(x, y, z, color) {
      const mesh = new THREE.Mesh(
        debrisGeo,
        new THREE.MeshStandardMaterial({
          color,
          metalness: 0.35,
          roughness: 0.7,
          flatShading: true,
          transparent: true,
        }),
      );
      mesh.position.set(x, y, z);
      scene.add(mesh);
      debris.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 7,
          Math.random() * 5 + 1,
          (Math.random() - 0.5) * 7,
        ),
        spin: new THREE.Vector3(Math.random() * 4, Math.random() * 4, Math.random() * 4),
        life: 4,
      });
    },

    update(dt, t) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]!;
        p.vel.y -= G * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.life -= dt;
        p.mesh.material.opacity = Math.max(0, p.life);
        p.mesh.scale.setScalar(Math.max(0.1, p.life));
        if (p.life <= 0) {
          scene.remove(p.mesh);
          p.mesh.material.dispose();
          particles.splice(i, 1);
        }
      }

      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i]!;
        const surf = WATER_LEVEL + waveHeight(d.mesh.position.x, d.mesh.position.z, t);
        if (d.mesh.position.y < surf) {
          // Underwater: heavy drag and reduced effective gravity, so chunks
          // sink slowly rather than plummeting.
          d.vel.multiplyScalar(Math.pow(0.25, dt));
          d.vel.y -= G * dt * 0.25;
        } else {
          d.vel.y -= G * dt;
        }
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.life -= dt;
        if (d.life < 1) d.mesh.material.opacity = Math.max(0, d.life);
        if (d.life <= 0) {
          scene.remove(d.mesh);
          d.mesh.material.dispose();
          debris.splice(i, 1);
        }
      }
    },

    clear() {
      for (const p of particles) {
        scene.remove(p.mesh);
        p.mesh.material.dispose();
      }
      for (const d of debris) {
        scene.remove(d.mesh);
        d.mesh.material.dispose();
      }
      particles.length = 0;
      debris.length = 0;
    },
  };
}
