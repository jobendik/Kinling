/**
 * Creature lab: a bare turntable for inspecting a Kinling's sculpt, coat and
 * silhouette in rest pose. Dev-only (not part of the production build).
 *   /lab.html?seed=7&view=three|front|side|back|top|face&shells=12&bg=dark
 */
import * as THREE from 'three';
import { makeIdentity } from './sim/identity';
import { buildKinling } from './render/creature/build';

const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') ?? 7);
const view = q.get('view') ?? 'three';
const id = makeIdentity(seed);
if (q.has('coat')) id.look.coat = Number(q.get('coat'));

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Number(q.get('dpr') ?? 1));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const silhouette = q.get('bg') === 'sil';
scene.background = new THREE.Color(silhouette ? 0xe8e2d0 : 0x1a2622);
const cam = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 50);
const views: Record<string, [number, number, number, number]> = {
  three: [1.25, 0.62, 1.35, 0.28],
  front: [0, 0.4, 2.0, 0.3],
  side: [2.1, 0.35, -0.12, 0.28],
  back: [-0.9, 0.6, -1.9, 0.28],
  top: [0.01, 2.4, -0.1, 0.2],
  face: [0.28, 0.5, 1.0, 0.44],
  low: [0.9, 0.12, 1.5, 0.3],
  tail: [0.7, 0.55, -1.3, 0.36],
};
const v = views[view] ?? views.three;
cam.position.set(v[0], v[1], v[2]);
cam.lookAt(0, v[3], view === 'face' ? 0.3 : view === 'tail' ? -0.7 : -0.12);

scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x3a3020, 0.9));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.position.set(2.5, 4, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -1.2; sun.shadow.camera.right = 1.2; sun.shadow.camera.top = 1.2; sun.shadow.camera.bottom = -1.2;
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.012;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x9db8ff, 1.0);
rim.position.set(-3, 2, -3);
scene.add(rim);
const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshStandardMaterial({ color: silhouette ? 0xe8e2d0 : 0x33442f, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const t0 = performance.now();
const body = buildKinling(id.look, { shells: Number(q.get('shells') ?? 12), cell: Number(q.get('cell') ?? 0.0092) });
const buildMs = performance.now() - t0;
scene.add(body.group);
if (silhouette) {
  const black = new THREE.MeshBasicMaterial({ color: 0x111111 });
  body.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = black; });
  body.lantern.halo.visible = false;
}
const tri = body.mesh.geometry.index!.count / 3;
(window as unknown as Record<string, unknown>).__lab = { buildMs, tri, verts: body.mesh.geometry.getAttribute('position').count };
console.log(`built in ${buildMs.toFixed(0)}ms, ${tri} tris`);

const spin = q.has('spin');
renderer.setAnimationLoop((t) => {
  if (spin) body.group.rotation.y = t * 0.0006;
  renderer.render(scene, cam);
  (window as unknown as Record<string, unknown>).__ready = true;
});
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); });
