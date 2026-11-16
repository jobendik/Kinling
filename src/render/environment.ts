/**
 * The glade, built from the same analytic terrain the simulation walks on:
 * ground, grass that parts around bodies, the pond with ripples, the den
 * tree and nest, rocks, the hollow log, the berry bush, mushrooms, flowers
 * and the small lights that drift over it all.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp01, lerp, smoothstep } from '../core/math';
import { fbm2, fbm3, noise2 } from '../core/noise';
import { Rng } from '../core/rng';
import { BUSH, DEN_TREE, gladeEdge, heightAt, NEST, OBSTACLES, POND, SUN_STONE, WATER_Y, type Obstacle } from '../sim/terrain';
import { BUSH_CAPACITY, GRASS_PATCHES } from '../sim/world';

const MAX_RIPPLES = 10;
const PUSHERS = 4;

export interface EnvQuality { grass: number }

export class Environment {
  readonly group = new THREE.Group();
  readonly ground: THREE.Mesh;
  /** Meshes the pointer can hit when aiming at the world. */
  readonly pickables: THREE.Object3D[] = [];
  private grass!: THREE.Mesh;
  private grassCount = 0;
  private grassUniforms = {
    uTime: { value: 0 },
    uWind: { value: 0.5 },
    uPushers: { value: Array.from({ length: PUSHERS }, () => new THREE.Vector4(0, -99, 0, 0)) },
    uNight: { value: 0 },
  };
  private water!: THREE.Mesh;
  private waterUniforms = {
    uTime: { value: 0 },
    uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0)) },
    uSky: { value: new THREE.Color() },
    uDeep: { value: new THREE.Color(0x163c44) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uNight: { value: 0 },
  };
  private rippleIndex = 0;
  private berries: THREE.Mesh[] = [];
  private glowMats: THREE.MeshStandardMaterial[] = [];
  private motes!: THREE.Points;
  private moteUniforms = { uTime: { value: 0 }, uNight: { value: 0 }, uPixel: { value: 1 } };
  private leafMats: THREE.MeshStandardMaterial[] = [];
  private time = 0;

  constructor(scene: THREE.Scene, quality: EnvQuality) {
    scene.add(this.group);
    this.ground = this.buildGround();
    this.buildGrass(quality.grass);
    this.buildWater();
    this.buildObstacles();
    this.buildDen();
    this.buildBush();
    this.buildSmallLife();
    this.buildMotes();
  }

  // ── ground ─────────────────────────────────────────────────────
  private buildGround(): THREE.Mesh {
    const size = 34, seg = 200;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const grassA = new THREE.Color(0x3d5a2c), grassB = new THREE.Color(0x587438), soil = new THREE.Color(0x4a3a28);
    const bed = new THREE.Color(0x2c3a30), sand = new THREE.Color(0x7c7256), stone = new THREE.Color(0x8a8578), moss = new THREE.Color(0x4c6630), bank = new THREE.Color(0x2c4226);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const y = heightAt(x, z);
      pos.setY(i, y);
      const n = fbm2(x * 0.5, z * 0.5, 3, 5);
      c.copy(grassA).lerp(grassB, n);
      // worn earth where the play area is and around the nest
      const worn = (1 - smoothstep(0.6, 2.6, Math.hypot(x - 0.4, z - 0.6))) * 0.35 + (1 - smoothstep(0.3, 1.0, Math.hypot(x - NEST.x, z - NEST.z))) * 0.8;
      c.lerp(soil, clamp01(worn * (0.6 + 0.6 * fbm2(x * 2, z * 2, 2, 9))));
      // pond: wet sand at the rim, dark bed beneath
      const depth = WATER_Y - y;
      c.lerp(sand, smoothstep(-0.16, -0.01, depth) * (1 - smoothstep(0.02, 0.2, depth)));
      c.lerp(bed, smoothstep(0.02, 0.3, depth));
      // the sun stone
      const sd = Math.hypot(x - SUN_STONE.x, z - SUN_STONE.z);
      const st = 1 - smoothstep(SUN_STONE.r * 0.8, SUN_STONE.r * 1.02, sd + (noise2(x * 3, z * 3, 3) - 0.5) * 0.18);
      c.lerp(stone, st);
      c.lerp(moss, st * smoothstep(0.55, 0.75, fbm2(x * 2.4, z * 2.4, 2, 12)) * 0.8);
      // the bank under the trees is darker, shadier
      const over = Math.hypot(x, z) - gladeEdge(x, z);
      c.lerp(bank, smoothstep(-0.6, 2.5, over) * 0.75);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    this.group.add(mesh);
    this.pickables.push(mesh);
    return mesh;
  }

  // ── grass ──────────────────────────────────────────────────────
  private buildGrass(density: number): void {
    // one tuft: three tapered blades fanned around the root
    const pos: number[] = [], idx: number[] = [], uv: number[] = [];
    for (let b = 0; b < 3; b++) {
      const a = (b / 3) * Math.PI * 2 + 0.4;
      const dx = Math.cos(a), dz = Math.sin(a);
      const lean = 0.35;
      const base = pos.length / 3;
      const w = 0.011;
      const pts = [
        [-w, 0], [w, 0], [-w * 0.7, 0.5], [w * 0.7, 0.5], [0, 1],
      ];
      for (const [px, py] of pts) {
        pos.push(dx * px - dz * lean * py * py * 0.09 + dx * 0.012, py * 0.15, dz * px + dx * lean * py * py * 0.09 + dz * 0.012);
        uv.push(px / w, py);
      }
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const normals = new Float32Array(pos.length);
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1; // lit as ground: soft, never black
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    const rng = new Rng(4242);
    const max = Math.round(70000 * density);
    const off = new Float32Array(max * 4), tint = new Float32Array(max * 3);
    const cA = new THREE.Color(0x4f7a30), cB = new THREE.Color(0x86a046), cDry = new THREE.Color(0xa7a658), cDark = new THREE.Color(0x2f5226);
    const c = new THREE.Color();
    let n = 0;
    for (let tries = 0; tries < max * 4 && n < max; tries++) {
      const r = Math.pow(rng.next(), 0.62) * 13.5, a = rng.range(0, Math.PI * 2);
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      const y = heightAt(x, z);
      if (y < WATER_Y + 0.015) continue;
      if (Math.hypot(x - SUN_STONE.x, z - SUN_STONE.z) < SUN_STONE.r * 0.92) continue;
      if (Math.hypot(x - NEST.x, z - NEST.z) < NEST.r * 0.85) continue;
      let blocked = false;
      for (const o of OBSTACLES) if (Math.hypot(x - o.x, z - o.z) < o.r * 0.82) { blocked = true; break; }
      if (blocked) continue;
      // a shorter lawn where most of the playing happens; tall stands in the patches
      const lawn = 1 - smoothstep(1.2, 3.4, Math.hypot(x - 0.4, z - 0.6));
      let tall = 0;
      for (const g of GRASS_PATCHES) tall = Math.max(tall, 1 - smoothstep(g.r * 0.55, g.r * 1.05, Math.hypot(x - g.x, z - g.z)));
      const over = smoothstep(-0.5, 2, Math.hypot(x, z) - gladeEdge(x, z));
      const clump = fbm2(x * 0.8, z * 0.8, 2, 77);
      if (rng.next() > 0.45 + 0.55 * clump + tall - lawn * 0.25) continue;
      const hgt = (0.5 + 0.7 * clump) * (1 - 0.5 * lawn) * (1 + 1.7 * tall) * (1 + 0.5 * over) * rng.range(0.75, 1.25);
      off[n * 4] = x; off[n * 4 + 1] = y; off[n * 4 + 2] = z; off[n * 4 + 3] = hgt + Math.floor(rng.range(0, 6.28) * 100) * 10;
      c.copy(cA).lerp(cB, clump).lerp(cDry, tall * 0.5 * rng.next()).lerp(cDark, over * 0.6);
      c.multiplyScalar(rng.range(0.85, 1.12));
      tint[n * 3] = c.r; tint[n * 3 + 1] = c.g; tint[n * 3 + 2] = c.b;
      n++;
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off.subarray(0, n * 4), 4));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint.subarray(0, n * 3), 3));
    geo.instanceCount = n;
    this.grassCount = n;

    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    const uniforms = this.grassUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 aOffset;
attribute vec3 aTint;
uniform float uTime;
uniform float uWind;
uniform vec4 uPushers[${PUSHERS}];
varying vec3 vTint;
varying float vH;`,
        )
        .replace(
          '#include <begin_vertex>',
          `float packed = aOffset.w;
float rot = floor(packed / 10.0) / 100.0;
float hgt = packed - floor(packed / 10.0) * 10.0;
float cr = cos(rot), sr = sin(rot);
vec3 lp = vec3(position.x * cr - position.z * sr, position.y * hgt, position.x * sr + position.z * cr);
lp.xz *= 0.8 + 0.25 * hgt;
vec3 root = aOffset.xyz;
float tip = uv.y * uv.y;
// wind: slow gusts rolling across the glade plus a quick flutter
float gust = sin(root.x * 0.55 + uTime * 0.9) * sin(root.z * 0.4 - uTime * 0.6) + 0.5 * sin(root.x * 1.7 + root.z * 1.3 + uTime * 1.7);
lp.x += gust * 0.05 * tip * hgt * (0.4 + uWind);
lp.z += (0.6 * gust + 0.3 * sin(uTime * 3.1 + root.x * 5.0)) * 0.03 * tip * hgt * (0.4 + uWind);
// bodies part the grass and press it down
for (int i = 0; i < ${PUSHERS}; i++) {
  vec4 pu = uPushers[i];
  vec2 d = root.xz - pu.xz;
  float dist = length(d);
  float k = (1.0 - smoothstep(pu.w * 0.3, pu.w, dist)) * step(abs(root.y - pu.y), 0.6);
  lp.xz += normalize(d + 0.0001) * k * 0.13 * tip * hgt;
  lp.y *= 1.0 - 0.55 * k * uv.y;
}
vec3 transformed = root + lp;
vTint = aTint;
vH = uv.y;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTint;\nvarying float vH;\nuniform float uNight;')
        .replace('#include <color_fragment>', 'diffuseColor.rgb = vTint * mix(0.42, 1.12, vH);')
        // blades are lit like the ground beneath them, from either side
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );');
    };
    mat.customProgramCacheKey = () => 'kinling-grass';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'grass';
    this.grass = mesh;
    this.group.add(mesh);
  }

  setGrassDensity(fraction: number): void {
    (this.grass.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.round(this.grassCount * clamp01(fraction));
  }

  // ── water ──────────────────────────────────────────────────────
  private buildWater(): void {
    const span = (POND.r + 1.1) * 2;
    const geo = new THREE.PlaneGeometry(span, span, 64, 64);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    const depth = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) depth[i] = WATER_Y - heightAt(pos.getX(i) + POND.x, pos.getZ(i) + POND.z);
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: this.waterUniforms,
      vertexShader: /* glsl */ `
        attribute float aDepth;
        varying float vDepth;
        varying vec3 vWorld;
        void main() {
          vDepth = aDepth;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uNight;
        uniform vec4 uRipples[${MAX_RIPPLES}];
        uniform vec3 uSky, uDeep, uSunDir, uSunColor;
        varying float vDepth;
        varying vec3 vWorld;
        void main() {
          if (vDepth < -0.01) discard;
          vec2 p = vWorld.xz;
          // gentle standing wavelets
          vec2 g = vec2(cos(p.x * 6.0 + uTime * 0.9) + cos((p.x + p.y) * 4.0 - uTime * 0.7), cos(p.y * 5.0 - uTime * 0.8) + sin((p.x - p.y) * 3.3 + uTime * 0.6)) * 0.03;
          float ring = 0.0;
          for (int i = 0; i < ${MAX_RIPPLES}; i++) {
            vec4 r = uRipples[i];
            float age = uTime - r.z;
            if (age < 0.0 || age > 4.0) continue;
            vec2 d = p - r.xy;
            float dist = length(d);
            float front = age * 0.75;
            float w = sin((dist - front) * 26.0) * exp(-abs(dist - front) * 7.0) * exp(-age * 1.1) * r.w;
            ring += w;
            g += normalize(d + 0.0001) * w * 0.5;
          }
          vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
          vec3 v = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
          vec3 col = mix(uDeep, uSky, 0.18 + 0.72 * fres);
          vec3 h = normalize(v + uSunDir);
          col += uSunColor * pow(max(dot(n, h), 0.0), 220.0) * 1.6 * (1.0 - 0.6 * uNight);
          col += ring * 0.25 * uSky;
          float shore = smoothstep(0.0, 0.05, vDepth);
          float foam = (1.0 - smoothstep(0.0, 0.035, vDepth)) * (0.5 + 0.5 * sin(p.x * 30.0 + p.y * 24.0 + uTime * 1.5)) * 0.25;
          float alpha = shore * mix(0.5, 0.92, smoothstep(0.02, 0.35, vDepth)) + foam;
          gl_FragColor = vec4(col + foam, clamp(alpha, 0.0, 0.95));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.set(POND.x, WATER_Y, POND.z);
    this.water.renderOrder = 1;
    this.water.name = 'water';
    this.group.add(this.water);
    this.pickables.push(this.water);

    // reeds on the far bank and a few lily pads
    const rng = new Rng(991);
    const reedGeo = new THREE.ConeGeometry(0.012, 1, 4);
    reedGeo.translate(0, 0.5, 0);
    const reeds = new THREE.InstancedMesh(reedGeo, new THREE.MeshLambertMaterial({ color: 0x5d7a38 }), 70);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let rn = 0;
    for (let i = 0; i < 400 && rn < 70; i++) {
      const a = rng.range(Math.PI * 0.9, Math.PI * 2.1), r = POND.r * rng.range(0.75, 1.15);
      const x = POND.x + Math.sin(a) * r, z = POND.z + Math.cos(a) * r;
      const d = WATER_Y - heightAt(x, z);
      if (d < -0.03 || d > 0.12) continue;
      q.setFromEuler(new THREE.Euler(rng.range(-0.14, 0.14), rng.range(0, 6), rng.range(-0.14, 0.14)));
      s.set(1, rng.range(0.45, 1.05), 1);
      p.set(x, heightAt(x, z), z);
      reeds.setMatrixAt(rn++, m.compose(p, q, s));
    }
    reeds.count = rn;
    reeds.castShadow = true;
    this.group.add(reeds);
    const padGeo = new THREE.CircleGeometry(0.16, 14, 0.3, Math.PI * 2 - 0.5);
    padGeo.rotateX(-Math.PI / 2);
    const pads = new THREE.InstancedMesh(padGeo, new THREE.MeshLambertMaterial({ color: 0x3f7244, side: THREE.DoubleSide }), 7);
    let pn = 0;
    for (let i = 0; i < 80 && pn < 7; i++) {
      const a = rng.range(0, 6.28), r = POND.r * rng.range(0.15, 0.6);
      const x = POND.x + Math.sin(a) * r, z = POND.z + Math.cos(a) * r;
      if (WATER_Y - heightAt(x, z) < 0.15) continue;
      q.setFromEuler(new THREE.Euler(0, rng.range(0, 6), 0));
      s.setScalar(rng.range(0.6, 1.2));
      pads.setMatrixAt(pn++, m.compose(p.set(x, WATER_Y + 0.004, z), q, s));
    }
    pads.count = pn;
    pads.renderOrder = 2;
    this.group.add(pads);
  }

  ripple(x: number, z: number, strength: number): void {
    if (WATER_Y - heightAt(x, z) < -0.05) return;
    const r = this.waterUniforms.uRipples.value[this.rippleIndex++ % MAX_RIPPLES];
    r.set(x, z, this.time, strength);
  }

  // ── rocks, log, trees ──────────────────────────────────────────
  private blob(radius: number, detail: number, seed: number, squash: number, rough: number, top: THREE.Color, base: THREE.Color, mossy = 0): THREE.BufferGeometry {
    let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(radius, detail);
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    geo = mergeVertices(geo, radius * 1e-3); // shared vertices → smooth, continuous shading
    const pos = geo.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3(), c = new THREE.Color(), moss = new THREE.Color(0x56753a);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = fbm3(v.x / radius * 1.3 + seed, v.y / radius * 1.3, v.z / radius * 1.3, 3, seed);
      const k = 1 + (n - 0.5) * rough;
      v.multiplyScalar(k);
      v.y *= squash;
      pos.setXYZ(i, v.x, v.y, v.z);
      const up = clamp01(v.y / (radius * squash) * 0.5 + 0.5);
      c.copy(base).lerp(top, up).multiplyScalar(0.8 + n * 0.4);
      if (mossy > 0) c.lerp(moss, mossy * smoothstep(0.55, 0.9, up) * smoothstep(0.35, 0.65, fbm3(v.x * 4, v.y * 4, v.z * 4, 2, seed + 5)));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return geo;
  }

  private buildObstacles(): void {
    const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.leafMats.push(leafMat);
    for (const o of OBSTACLES) {
      const y = heightAt(o.x, o.z);
      const rng = new Rng(o.seed);
      if (o.kind === 'rock') {
        const g = this.blob(o.r * 1.12, 3, o.seed % 97, o.h / o.r * 0.75, 0.5, new THREE.Color(0x9a958a), new THREE.Color(0x5b574f), 0.9);
        const m = new THREE.Mesh(g, rockMat);
        m.position.set(o.x, y + o.h * 0.22, o.z);
        m.rotation.y = rng.range(0, 6);
        m.castShadow = m.receiveShadow = true;
        this.group.add(m);
        this.pickables.push(m);
        // a companion pebble or two so it sits in the ground rather than on it
        for (let i = 0; i < 2; i++) {
          const a = rng.range(0, 6.28), d = o.r * rng.range(0.95, 1.25), r = o.r * rng.range(0.18, 0.3);
          const px = o.x + Math.sin(a) * d, pz = o.z + Math.cos(a) * d;
          const pm = new THREE.Mesh(this.blob(r, 2, (o.seed + i * 13) % 97, 0.7, 0.5, new THREE.Color(0x8f8a80), new THREE.Color(0x56524b), 0.6), rockMat);
          pm.position.set(px, heightAt(px, pz) + r * 0.25, pz);
          pm.castShadow = pm.receiveShadow = true;
          this.group.add(pm);
        }
      } else if (o.kind === 'log') {
        this.buildLog(o, barkMat);
      } else if (o.kind === 'tree') {
        this.buildTree(o, barkMat, leafMat, rng);
      }
    }
  }

  private barkTube(radiusTop: number, radiusBottom: number, height: number, seed: number, open = false): THREE.BufferGeometry {
    const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 28, 16, open);
    const pos = geo.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const a = new THREE.Color(0x4a3626), b = new THREE.Color(0x2c2018), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const ang = Math.atan2(x, z);
      const n = fbm2(ang * 3 + seed, y * 1.4, 3, seed);
      const k = 1 + (n - 0.5) * 0.22;
      pos.setX(i, x * k); pos.setZ(i, z * k);
      c.copy(a).lerp(b, smoothstep(0.35, 0.7, noise2(ang * 9 + seed, y * 0.8, seed))).multiplyScalar(0.8 + n * 0.4);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return geo;
  }

  private buildLog(o: Obstacle, barkMat: THREE.Material): void {
    const y = heightAt(o.x, o.z);
    const len = o.r * 2.3, rad = o.h * 0.56;
    const geo = this.barkTube(rad * 0.92, rad, len, 31, true);
    const outer = new THREE.Mesh(geo, barkMat);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.74, rad * 0.8, len * 0.99, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0x1c140f, roughness: 1, side: THREE.BackSide }));
    const g = new THREE.Group();
    g.add(outer, inner);
    for (const end of [1, -1]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(rad * 0.74, rad * 0.94, 16), new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 1, side: THREE.DoubleSide }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = end * len * 0.5;
      g.add(ring);
    }
    g.rotation.z = Math.PI / 2;
    g.rotation.y = 0.5;
    g.position.set(o.x, y + rad * 0.82, o.z);
    g.traverse((m) => { if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    this.group.add(g);
    this.pickables.push(outer);
    // moss along the top
    const moss = new THREE.Mesh(this.blob(rad * 0.9, 2, 5, 0.3, 0.6, new THREE.Color(0x66883e), new THREE.Color(0x3c5a2a)), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    moss.position.set(o.x - 0.15, y + rad * 1.66, o.z + 0.1);
    moss.scale.set(1.5, 1, 0.8);
    moss.rotation.y = 0.5;
    moss.receiveShadow = true;
    this.group.add(moss);
  }

  private canopy(rng: Rng, radius: number, leafMat: THREE.Material, dark: number): THREE.Group {
    const g = new THREE.Group();
    const n = rng.int(4, 6);
    const top = new THREE.Color(0x6f9a46).multiplyScalar(1 - dark * 0.35), base = new THREE.Color(0x2c4a26).multiplyScalar(1 - dark * 0.3);
    for (let i = 0; i < n; i++) {
      const r = radius * rng.range(0.55, 0.9);
      const m = new THREE.Mesh(this.blob(r, 2, rng.int(1, 90), rng.range(0.6, 0.8), 0.55, top, base), leafMat);
      const a = rng.range(0, 6.28), d = radius * rng.range(0, 0.75);
      m.position.set(Math.sin(a) * d, rng.range(-0.3, 0.5) * radius, Math.cos(a) * d);
      m.castShadow = true;
      g.add(m);
    }
    return g;
  }

  private buildTree(o: Obstacle, barkMat: THREE.Material, leafMat: THREE.Material, rng: Rng): void {
    const y = heightAt(o.x, o.z);
    const trunk = new THREE.Mesh(this.barkTube(o.r * 0.6, o.r * 1.15, o.h, o.seed % 50), barkMat);
    trunk.position.set(o.x, y + o.h * 0.5 - 0.2, o.z);
    trunk.rotation.z = rng.range(-0.06, 0.06);
    trunk.castShadow = true;
    this.group.add(trunk);
    const c = this.canopy(rng, o.h * 0.42, leafMat, rng.next());
    c.position.set(o.x, y + o.h * 0.92, o.z);
    this.group.add(c);
  }

  // ── the den tree and the nest between its roots ────────────────
  private buildDen(): void {
    const barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.leafMats.push(leafMat);
    const rng = new Rng(2024);
    const y = heightAt(DEN_TREE.x, DEN_TREE.z);
    // a broad old trunk that flares into the ground
    const trunkGeo = this.barkTube(DEN_TREE.r * 0.72, DEN_TREE.r * 0.9, 9.6, 7);
    {
      const tp = trunkGeo.getAttribute('position');
      for (let i = 0; i < tp.count; i++) {
        const hy = tp.getY(i) + 4.8; // height above the base
        const ang = Math.atan2(tp.getX(i), tp.getZ(i));
        const flare = 1 + 0.7 * Math.exp(-hy / 0.8) * (0.85 + 0.15 * Math.sin(ang * 5 + 1.3));
        tp.setX(i, tp.getX(i) * flare); tp.setZ(i, tp.getZ(i) * flare);
      }
      trunkGeo.computeVertexNormals();
    }
    const trunk = new THREE.Mesh(trunkGeo, barkMat);
    trunk.position.set(DEN_TREE.x, y + 4.2, DEN_TREE.z);
    trunk.castShadow = trunk.receiveShadow = true;
    this.group.add(trunk);
    this.pickables.push(trunk);
    const canopy = this.canopy(rng, 4.2, leafMat, 0.2);
    canopy.position.set(DEN_TREE.x, y + 8.6, DEN_TREE.z + 1);
    this.group.add(canopy);
    const canopy2 = this.canopy(rng, 3, leafMat, 0.5);
    canopy2.position.set(DEN_TREE.x - 2.5, y + 7.2, DEN_TREE.z + 2.6);
    this.group.add(canopy2);
    // the great canopy shelters without throwing the whole nest into gloom
    for (const c of [canopy, canopy2]) c.traverse((o) => { o.castShadow = false; });

    // buttress roots that reach forward and curl around the nest
    const colourTube = (geo: THREE.BufferGeometry): void => {
      const pos = geo.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      const a = new THREE.Color(0x4f3a29), b = new THREE.Color(0x2e2219), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const n = fbm3(pos.getX(i) * 3, pos.getY(i) * 3, pos.getZ(i) * 3, 2, 3);
        c.copy(a).lerp(b, n);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    };
    const root = (ax: number, az: number, bx: number, bz: number, lift: number, r0: number): void => {
      const a = new THREE.Vector3(DEN_TREE.x + ax, y + 0.62, DEN_TREE.z + az);
      const mid = new THREE.Vector3((DEN_TREE.x + ax + bx) / 2, 0, (DEN_TREE.z + az + bz) / 2);
      mid.y = heightAt(mid.x, mid.z) + lift;
      const b = new THREE.Vector3(bx, heightAt(bx, bz) - 0.06, bz);
      const q1 = a.clone().lerp(mid, 0.5);
      q1.y = Math.max(heightAt(q1.x, q1.z) + lift * 0.9, (a.y + mid.y) / 2);
      const curve = new THREE.CatmullRomCurve3([a, q1, mid, b]);
      const geo = new THREE.TubeGeometry(curve, 20, r0, 8);
      // taper toward the tip
      const pos = geo.getAttribute('position');
      const centre = new THREE.Vector3(), v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        const ring = Math.floor(i / 9);
        const t = ring / 20;
        curve.getPoint(t, centre);
        v.fromBufferAttribute(pos, i).sub(centre).multiplyScalar(1 - 0.72 * t).add(centre);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();
      colourTube(geo);
      const m = new THREE.Mesh(geo, barkMat);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
    };
    root(-0.8, 0.6, NEST.x - 0.98, NEST.z + 0.55, 0.2, 0.27);
    root(0.3, 0.95, NEST.x + 0.9, NEST.z + 0.8, 0.22, 0.25);
    root(-0.25, 0.9, NEST.x - 0.1, NEST.z - 0.78, 0.16, 0.2);
    root(1.0, 0.3, DEN_TREE.x + 2.3, DEN_TREE.z + 1.5, 0.12, 0.24);
    root(-1.05, -0.1, DEN_TREE.x - 2.5, DEN_TREE.z + 0.8, 0.12, 0.23);

    // the nest: a ring of moss and a bed of dry leaves
    const ny = heightAt(NEST.x, NEST.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(NEST.r * 0.86, 0.11, 8, 28), new THREE.MeshStandardMaterial({ color: 0x55703a, roughness: 1 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(NEST.x, ny + 0.035, NEST.z);
    ring.scale.set(1, 1, 0.55);
    ring.receiveShadow = true;
    this.group.add(ring);
    const leafGeo = new THREE.CircleGeometry(0.07, 5);
    leafGeo.rotateX(-Math.PI / 2);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 90);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), lc = new THREE.Color();
    for (let i = 0; i < 90; i++) {
      const a = rng.range(0, 6.28), r = Math.sqrt(rng.next()) * NEST.r * 0.9;
      const x = NEST.x + Math.sin(a) * r, z = NEST.z + Math.cos(a) * r;
      q.setFromEuler(new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 6), rng.range(-0.3, 0.3)));
      s.set(rng.range(0.7, 1.4), 1, rng.range(0.5, 1));
      leaves.setMatrixAt(i, m4.compose(p.set(x, heightAt(x, z) + 0.012 + rng.next() * 0.012, z), q, s));
      leaves.setColorAt(i, lc.setHex(rng.pick([0x8a6a3a, 0x9c7a42, 0x6f5a34, 0xa88748, 0x7a7038])));
    }
    leaves.receiveShadow = true;
    this.group.add(leaves);
  }

  // ── berry bush ─────────────────────────────────────────────────
  private buildBush(): void {
    const rng = new Rng(555);
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const y = heightAt(BUSH.x, BUSH.z);
    for (let i = 0; i < 6; i++) {
      const r = BUSH.r * rng.range(0.45, 0.7);
      const m = new THREE.Mesh(this.blob(r, 2, rng.int(1, 80), 0.8, 0.5, new THREE.Color(0x5e8f46), new THREE.Color(0x29492a)), leafMat);
      const a = (i / 6) * 6.28, d = BUSH.r * (i === 0 ? 0 : 0.5);
      m.position.set(BUSH.x + Math.sin(a) * d, y + r * 0.7 + (i === 0 ? 0.25 : 0), BUSH.z + Math.cos(a) * d);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      if (i === 0) this.pickables.push(m);
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8304a, roughness: 0.35, emissive: 0x5a1020, emissiveIntensity: 0.5 });
    this.glowMats.push(mat);
    const toCentre = Math.atan2(-BUSH.x, -BUSH.z);
    for (let i = 0; i < BUSH_CAPACITY; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 10), mat);
      const a = toCentre + (i - 1) * 0.55;
      b.position.set(BUSH.x + Math.sin(a) * BUSH.r * 0.92, y + 0.26 + (i % 2) * 0.1, BUSH.z + Math.cos(a) * BUSH.r * 0.92);
      b.castShadow = true;
      this.berries.push(b);
      this.group.add(b);
    }
  }

  setBushStock(n: number): void {
    for (let i = 0; i < this.berries.length; i++) this.berries[i].visible = i < n;
  }

  // ── mushrooms and flowers ──────────────────────────────────────
  private buildSmallLife(): void {
    const rng = new Rng(8080);
    const capMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a8, roughness: 0.6, emissive: 0x7fd6c2, emissiveIntensity: 0 });
    this.glowMats.push(capMat);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0xe6dcc6, roughness: 0.8 });
    const capGeo = new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const stemGeo = new THREE.CylinderGeometry(0.22, 0.3, 1, 6);
    stemGeo.translate(0, 0.5, 0);
    const count = 46;
    const caps = new THREE.InstancedMesh(capGeo, capMat, count), stems = new THREE.InstancedMesh(stemGeo, stemMat, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const spots: Array<[number, number, number]> = [[-4.3, -2.7, 1.0], [DEN_TREE.x - 1.6, DEN_TREE.z + 1.3, 0.8], [-1.5, -3.1, 0.75], [3.3, -4.2, 0.8], [-5.6, 2.9, 0.6]];
    let n = 0;
    // a fairy ring near the front of the glade
    for (let i = 0; i < 11 && n < count; i++) {
      const a = (i / 11) * 6.28;
      spots.push([2.6 + Math.sin(a) * 0.62, 4.5 + Math.cos(a) * 0.62, 0.02]);
    }
    for (let i = 0; n < count && i < 400; i++) {
      const sp = spots[i % spots.length];
      const a = rng.range(0, 6.28), r = sp[2] * rng.range(0.75, 1.15);
      const x = sp[0] + Math.sin(a) * r, z = sp[1] + Math.cos(a) * r;
      let blocked = false;
      for (const o of OBSTACLES) if (Math.hypot(x - o.x, z - o.z) < o.r * 0.95) blocked = true;
      if (blocked) continue;
      const h = rng.range(0.05, 0.13), cap = rng.range(0.03, 0.06);
      const y = heightAt(x, z);
      q.setFromEuler(new THREE.Euler(rng.range(-0.15, 0.15), rng.range(0, 6), rng.range(-0.15, 0.15)));
      stems.setMatrixAt(n, m.compose(p.set(x, y, z), q, s.set(cap * 0.35, h, cap * 0.35)));
      caps.setMatrixAt(n, m.compose(p.set(x, y + h * 0.92, z), q, s.set(cap, cap * 0.75, cap)));
      n++;
    }
    caps.count = stems.count = n;
    caps.castShadow = true;
    this.group.add(caps, stems);

    // flowers: small five-petalled stars on thin stems, in drifts
    const petal = new THREE.CircleGeometry(0.03, 5);
    petal.rotateX(-Math.PI / 2.4);
    const flowers = new THREE.InstancedMesh(petal, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 150);
    const fc = new THREE.Color();
    let fn = 0;
    for (let i = 0; i < 1200 && fn < 150; i++) {
      const a = rng.range(0, 6.28), r = Math.sqrt(rng.next()) * 8.5;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (fbm2(x * 0.45 + 30, z * 0.45, 2, 61) < 0.56) continue;
      const y = heightAt(x, z);
      if (y < WATER_Y + 0.03) continue;
      q.setFromEuler(new THREE.Euler(0, rng.range(0, 6), 0));
      flowers.setMatrixAt(fn, m.compose(p.set(x, y + rng.range(0.1, 0.2), z), q, s.setScalar(rng.range(0.7, 1.4))));
      flowers.setColorAt(fn, fc.setHex(rng.pick([0xf4ecd0, 0xf2c14e, 0xc9a6f0, 0xf6d7e2, 0xf4ecd0])));
      fn++;
    }
    flowers.count = fn;
    this.group.add(flowers);
  }

  // ── drifting motes by day, fireflies by night ──────────────────
  private buildMotes(): void {
    const count = 110;
    const rng = new Rng(31337);
    const pos = new Float32Array(count * 3), seed = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, 6.28), r = Math.sqrt(rng.next()) * 8.5;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      pos[i * 3] = x; pos[i * 3 + 1] = heightAt(x, z) + rng.range(0.25, 1.9); pos[i * 3 + 2] = z;
      seed[i * 3] = rng.next(); seed[i * 3 + 1] = rng.next(); seed[i * 3 + 2] = rng.next();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: this.moteUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime, uNight, uPixel;
        varying float vAlpha;
        varying float vFire;
        void main() {
          vec3 p = position;
          float t = uTime * (0.25 + aSeed.x * 0.4);
          p.x += sin(t + aSeed.y * 40.0) * 0.6 + sin(t * 0.37 + aSeed.z * 9.0) * 0.5;
          p.z += cos(t * 0.8 + aSeed.x * 30.0) * 0.6;
          p.y += sin(t * 1.3 + aSeed.z * 20.0) * 0.22;
          // a third are fireflies: they only wake at dusk and pulse slowly
          vFire = step(0.62, aSeed.z);
          float pulse = 0.5 + 0.5 * sin(uTime * (1.2 + aSeed.x * 1.5) + aSeed.y * 30.0);
          float fire = vFire * uNight * smoothstep(0.35, 0.95, pulse);
          float dust = (1.0 - vFire) * (1.0 - uNight) * 0.3 * (0.5 + 0.5 * sin(t * 2.0 + aSeed.y * 10.0));
          vAlpha = fire + dust;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(uPixel * mix(7.0, 22.0, vFire) / max(-mv.z, 0.5), 46.0 * uPixel / 3.2);
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying float vFire;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = pow(max(1.0 - d, 0.0), 2.2) * vAlpha;
          if (a < 0.003) discard;
          vec3 col = mix(vec3(1.0, 0.96, 0.82), vec3(0.85, 1.0, 0.45), vFire);
          gl_FragColor = vec4(col * a * (1.0 + vFire * 1.5), a);
        }`,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 5;
    this.group.add(this.motes);
  }

  update(dt: number, opts: { night: number; skyColor: THREE.Color; sunDir: THREE.Vector3; sunColor: THREE.Color; pushers: Array<{ x: number; y: number; z: number; r: number }>; pixelRatio: number; wind: number }): void {
    this.time += dt;
    const t = this.time;
    this.grassUniforms.uTime.value = t;
    this.grassUniforms.uWind.value = opts.wind;
    this.grassUniforms.uNight.value = opts.night;
    const pu = this.grassUniforms.uPushers.value;
    for (let i = 0; i < PUSHERS; i++) {
      const p = opts.pushers[i];
      if (p) pu[i].set(p.x, p.y, p.z, p.r);
      else pu[i].set(0, -99, 0, 0.001);
    }
    const w = this.waterUniforms;
    w.uTime.value = t;
    w.uSky.value.copy(opts.skyColor);
    w.uSunDir.value.copy(opts.sunDir);
    w.uSunColor.value.copy(opts.sunColor);
    w.uNight.value = opts.night;
    w.uDeep.value.setHex(0x163c44).multiplyScalar(lerp(1, 0.45, opts.night));
    this.moteUniforms.uTime.value = t;
    this.moteUniforms.uNight.value = opts.night;
    this.moteUniforms.uPixel.value = opts.pixelRatio * 3.2;
    // mushrooms and berries hold a little light after dark
    for (const m of this.glowMats) m.emissiveIntensity = m.color.getHex() === 0xb8304a ? 0.35 + 0.9 * opts.night : 1.1 * opts.night;
  }
}
