/**
 * Renderer, camera, sky dome and lighting.
 *
 * Pure presentation — nothing here feeds back into the simulation. The scene
 * is created once and handed to the game; the loop mutates it each frame.
 */

import * as THREE from 'three';

export interface Stage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  amb: THREE.AmbientLight;
  fog: THREE.FogExp2;
}

/** Surface-level lighting levels, restored whenever the camera is above water. */
export const SURFACE_LIGHT = { sun: 1.15, hemi: 0.65, amb: 0.4 } as const;
export const SURFACE_FOG = { color: 0x9fc4d8, density: 0.0028 } as const;

export function createStage(mount: HTMLElement): Stage {
  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(SURFACE_FOG.color, SURFACE_FOG.density);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2000);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  // Sky: a single inverted sphere with a vertical gradient. Cheaper than a
  // cubemap and it costs no assets, which keeps the build dependency-free.
  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          top: { value: new THREE.Color(0x2b6ba3) },
          bot: { value: new THREE.Color(0xbfe0ec) },
        },
        vertexShader:
          'varying vec3 vp; void main(){ vp=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader:
          'varying vec3 vp; uniform vec3 top; uniform vec3 bot; void main(){ float h=normalize(vp).y*0.5+0.5; gl_FragColor=vec4(mix(bot,top,clamp(h,0.0,1.0)),1.0); }',
      }),
    ),
  );

  const sun = new THREE.DirectionalLight(0xfff0d4, SURFACE_LIGHT.sun);
  sun.position.set(60, 120, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  scene.add(sun);

  const hemi = new THREE.HemisphereLight(0xbfe0ec, 0x2a4a5a, SURFACE_LIGHT.hemi);
  const amb = new THREE.AmbientLight(0x4a6878, SURFACE_LIGHT.amb);
  scene.add(hemi);
  scene.add(amb);

  return { scene, camera, renderer, sun, hemi, amb, fog };
}

export function handleResize(stage: Stage): () => void {
  const onResize = () => {
    stage.camera.aspect = innerWidth / innerHeight;
    stage.camera.updateProjectionMatrix();
    stage.renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', onResize);
  return () => removeEventListener('resize', onResize);
}
