/**
 * The things in the glade that move: toys, berries, the wisp, and curios.
 * Each is a small designed object that mirrors a simulation entity.
 */
import * as THREE from 'three';
import { clamp01, damp } from '../core/math';
import type { Berry, Curio, Toy } from '../sim/entities';
import { heightAt } from '../sim/terrain';
import type { CurioKind } from '../sim/types';
import type { World } from '../sim/world';
import { glowTexture } from './creature/build';

function ballMesh(): THREE.Mesh {
  // a woven seed-pod ball: warm bands with a pale lattice
  const geo = new THREE.SphereGeometry(0.085, 28, 20);
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Color(0xc8553a), b = new THREE.Color(0xf0c26a), c = new THREE.Color(0x7a2f2a), out = new THREE.Color();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const lon = Math.atan2(v.x, v.z), lat = Math.asin(v.y);
    const weave = Math.sin(lon * 6 + lat * 5) * Math.sin(lon * 6 - lat * 5);
    out.copy(a).lerp(b, weave > 0.25 ? 1 : 0).lerp(c, Math.abs(weave) < 0.08 ? 0.8 : 0);
    col[i * 3] = out.r; col[i * 3 + 1] = out.g; col[i * 3 + 2] = out.b;
    const bump = 1 + (weave > 0.25 ? 0.03 : 0);
    pos.setXYZ(i, pos.getX(i) * bump, pos.getY(i) * bump, pos.getZ(i) * bump);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  m.castShadow = m.receiveShadow = true;
  m.name = 'ball';
  return m;
}

function rattleMesh(): THREE.Mesh {
  // a dried gourd rattle: bulb and neck, banded
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const r = t < 0.62 ? Math.sin((t / 0.62) * Math.PI) * 0.072 + 0.004 : 0.022 + 0.008 * Math.sin((t - 0.62) * 8);
    pts.push(new THREE.Vector2(Math.max(0.002, r), (t - 0.32) * 0.2));
  }
  const geo = new THREE.LatheGeometry(pts, 20);
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Color(0xd9b56a), b = new THREE.Color(0x4f8f86), c = new THREE.Color(0x8c5a2e), out = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const band = Math.abs(Math.sin(y * 70)) > 0.86 && y < 0.05;
    out.copy(a).lerp(b, band ? 1 : 0).lerp(c, y > 0.06 ? 0.7 : 0);
    col[i * 3] = out.r; col[i * 3 + 1] = out.g; col[i * 3 + 2] = out.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
  m.castShadow = m.receiveShadow = true;
  m.name = 'rattle';
  return m;
}

function curioMesh(kind: CurioKind): { group: THREE.Group; glow: THREE.MeshStandardMaterial; spin: THREE.Object3D | null } {
  const group = new THREE.Group();
  let spin: THREE.Object3D | null = null;
  const glow = new THREE.MeshStandardMaterial({ color: 0x9fe8d8, emissive: 0x6fe0cc, emissiveIntensity: 0.4, roughness: 0.4 });
  if (kind === 'hummer') {
    const stone = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14), new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.5 }));
    stone.scale.set(1, 0.72, 0.9);
    stone.position.y = 0.09;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.012, 8, 32), glow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.15;
    group.add(stone, ring);
  } else if (kind === 'spinner') {
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.014, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 }));
    stick.position.y = 0.25;
    const hub = new THREE.Group();
    hub.position.set(0, 0.48, 0.02);
    const cols = [0xe36a5c, 0xf0c26a, 0x6fb5a8, 0xb48ad6];
    for (let i = 0; i < 4; i++) {
      const vane = new THREE.Mesh(new THREE.CircleGeometry(0.11, 3), new THREE.MeshStandardMaterial({ color: cols[i], roughness: 0.6, side: THREE.DoubleSide }));
      vane.position.set(Math.cos((i / 4) * 6.283) * 0.07, Math.sin((i / 4) * 6.283) * 0.07, 0);
      vane.rotation.z = (i / 4) * 6.283;
      vane.rotation.y = 0.5;
      hub.add(vane);
    }
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), glow);
    hub.add(pin);
    group.add(stick, hub);
    spin = hub;
  } else {
    // a spiral shell that chimes
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60, a = t * Math.PI * 5.5, r = 0.02 + 0.11 * t;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0.05 + 0.13 * (1 - t) + 0.02, Math.sin(a) * r));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 90, 0.05, 10);
    const pos = geo.getAttribute('position');
    const centre = new THREE.Vector3(), v = new THREE.Vector3();
    const curve = new THREE.CatmullRomCurve3(pts);
    for (let i = 0; i < pos.count; i++) {
      const t = Math.floor(i / 11) / 90;
      curve.getPoint(t, centre);
      v.fromBufferAttribute(pos, i).sub(centre).multiplyScalar(0.25 + 0.95 * t).add(centre);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const shell = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: 0xe9d9cf, roughness: 0.25, clearcoat: 0.7, sheen: 1, sheenColor: 0xf0a8c8 }));
    const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), glow);
    pearl.position.set(0.02, 0.2, 0);
    group.add(shell, pearl);
  }
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.name = 'curio';
  return { group, glow, spin };
}

export class Props {
  readonly toys: Record<'ball' | 'rattle', THREE.Mesh>;
  readonly pickables: THREE.Object3D[] = [];
  private berryMeshes = new Map<Berry, THREE.Mesh>();
  private berryGeo = new THREE.SphereGeometry(0.03, 14, 10);
  private berryMat = new THREE.MeshStandardMaterial({ color: 0xc23350, roughness: 0.3, emissive: 0x6a1226, emissiveIntensity: 0.45 });
  private wisp: THREE.Group;
  private wispCore: THREE.Sprite;
  private wispLight: THREE.PointLight;
  private wispTrail: THREE.Sprite[] = [];
  private curio: { entity: Curio; group: THREE.Group; glow: THREE.MeshStandardMaterial; spin: THREE.Object3D | null; pulse: number } | null = null;
  private prevToy: Record<string, THREE.Vector3> = {};
  private time = 0;

  constructor(private scene: THREE.Scene, private world: World) {
    this.toys = { ball: ballMesh(), rattle: rattleMesh() };
    scene.add(this.toys.ball, this.toys.rattle);
    this.pickables.push(this.toys.ball, this.toys.rattle);

    this.wisp = new THREE.Group();
    const tex = glowTexture();
    this.wispCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xcff6ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.wispCore.scale.setScalar(0.3);
    this.wisp.add(this.wispCore);
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x9fe8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.3 }));
      s.scale.setScalar(0.16 - i * 0.018);
      this.wispTrail.push(s);
      scene.add(s);
    }
    this.wispLight = new THREE.PointLight(0xbfefff, 0, 2.2, 2);
    this.wisp.add(this.wispLight);
    this.wisp.visible = false;
    scene.add(this.wisp);
  }

  pulseCurio(): void {
    if (this.curio) this.curio.pulse = 1;
  }

  update(dt: number, alpha: number, mouth: THREE.Vector3, night: number): void {
    this.time += dt;
    const w = this.world;
    for (const kind of ['ball', 'rattle'] as const) {
      const toy: Toy = w.toys[kind];
      const mesh = this.toys[kind];
      if (toy.state === 'carried') {
        mesh.position.copy(mouth);
        mesh.position.y -= 0.01;
      } else {
        // interpolate between fixed steps for smooth flight
        const prev = this.prevToy[kind] ?? (this.prevToy[kind] = new THREE.Vector3().copy(toy.position as unknown as THREE.Vector3));
        mesh.position.set(toy.position.x, toy.position.y, toy.position.z);
        void prev; void alpha;
        mesh.rotation.set(toy.roll.x, 0, toy.roll.z);
        if (kind === 'rattle') { mesh.position.y -= 0.012; mesh.rotation.y = toy.roll.x * 0.3; }
      }
    }
    // berries
    for (const b of w.berries) {
      if (b.eaten) continue;
      let m = this.berryMeshes.get(b);
      if (!m) {
        m = new THREE.Mesh(this.berryGeo, this.berryMat);
        m.castShadow = true;
        this.berryMeshes.set(b, m);
        this.scene.add(m);
      }
      m.position.set(b.position.x, b.position.y, b.position.z);
    }
    for (const [b, m] of this.berryMeshes) if (b.eaten || !w.berries.includes(b)) { this.scene.remove(m); this.berryMeshes.delete(b); }
    this.berryMat.emissiveIntensity = 0.4 + 0.9 * night;

    // wisp
    const wi = w.wisp;
    this.wisp.visible = wi.on;
    if (wi.on) {
      this.wisp.position.set(wi.position.x, wi.position.y + Math.sin(this.time * 3.1) * 0.03, wi.position.z);
      const flick = 0.85 + 0.15 * Math.sin(this.time * 13) + (wi.escape > 0 ? 0.6 : 0);
      this.wispCore.scale.setScalar(0.26 * flick);
      this.wispLight.intensity = (0.25 + 0.9 * night) * flick;
    }
    let lead = this.wisp.position;
    for (let i = 0; i < this.wispTrail.length; i++) {
      const s = this.wispTrail[i];
      s.visible = wi.on;
      if (!wi.on) continue;
      s.position.x = damp(s.position.x, lead.x, 14 - i * 1.6, dt);
      s.position.y = damp(s.position.y, lead.y, 14 - i * 1.6, dt);
      s.position.z = damp(s.position.z, lead.z, 14 - i * 1.6, dt);
      lead = s.position;
    }

    // curio
    if (w.curio !== (this.curio?.entity ?? null)) {
      if (this.curio) { this.scene.remove(this.curio.group); const i = this.pickables.indexOf(this.curio.group); if (i >= 0) this.pickables.splice(i, 1); this.curio = null; }
      if (w.curio) {
        const c = curioMesh(w.curio.kind);
        c.group.position.set(w.curio.position.x, heightAt(w.curio.position.x, w.curio.position.z), w.curio.position.z);
        this.scene.add(c.group);
        this.pickables.push(c.group);
        this.curio = { entity: w.curio, ...c, pulse: 0 };
      }
    }
    if (this.curio) {
      const c = this.curio;
      c.pulse = damp(c.pulse, 0, 1.6, dt);
      c.glow.emissiveIntensity = 0.3 + 0.5 * night + 3 * c.pulse + 0.15 * Math.sin(this.time * 2);
      if (c.spin) c.spin.rotation.z += dt * (1.5 + 9 * c.pulse);
      c.group.scale.setScalar(1 + 0.06 * c.pulse * clamp01(Math.sin(this.time * 30) * 0.5 + 0.5));
    }
  }
}
