/**
 * Builds one Kinling's body from its anatomy and look: the sculpted skin,
 * automatic skin weights, painted coat, lofted ears, eyes with lids, nose,
 * mouth and the tail lantern. Pure construction; all motion lives in rig.ts.
 */
import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../../core/math';
import { fbm3 } from '../../core/noise';
import { Rng } from '../../core/rng';
import type { Look, TouchRegion } from '../../sim/identity';
import { buildAnatomy, TAIL_BONES, type Anatomy } from './anatomy';
import { bodyDistance, extractSurface, primDistance, type Vec3 } from './sdf';
import { createEyeMaterial, createFurShellMaterial, createLanternMaterial, createSkinMaterial, type FurUniforms } from './materials';

export interface Coat {
  back: THREE.Color;
  dark: THREE.Color;
  belly: THREE.Color;
  earInner: THREE.Color;
  lantern: THREE.Color;
  nose: THREE.Color;
}

const COATS: Array<Record<keyof Coat, number>> = [
  { back: 0xc87a42, dark: 0x6a3520, belly: 0xf7e8cc, earInner: 0xeda28c, lantern: 0xffb24a, nose: 0x2a1512 }, // ember
  { back: 0x7187ae, dark: 0x384468, belly: 0xeee8f2, earInner: 0xdca4bc, lantern: 0xffc87a, nose: 0x161a26 }, // dusk
  { back: 0x96a45e, dark: 0x4a5830, belly: 0xf4eed2, earInner: 0xe6b28e, lantern: 0xdcff78, nose: 0x1c1f12 }, // moss
  { back: 0xa878a6, dark: 0x5a3c62, belly: 0xf6e8ec, earInner: 0xf2a6a6, lantern: 0xff9ccd, nose: 0x231424 }, // heather
];
const EYE_COLORS = [0xd9892a, 0x8fae3c, 0x3aa39a, 0x8a6fd0, 0xc9742f, 0x4f97c9];

export function coatFor(look: Look): Coat {
  const c = COATS[look.coat % COATS.length];
  const out = {} as Coat;
  for (const key of Object.keys(c) as Array<keyof Coat>) {
    const col = new THREE.Color(c[key]);
    if (key !== 'belly' && key !== 'nose') col.offsetHSL(look.hueShift, 0, 0);
    out[key] = col;
  }
  return out;
}

export interface EyeRig {
  root: THREE.Group;
  ball: THREE.Mesh;
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  uniforms: { uPupil: { value: number }; uGlint: { value: number } };
}

export interface TouchProxy {
  bone: THREE.Bone;
  offset: THREE.Vector3;
  radius: number;
  region: TouchRegion;
}

export interface KinlingBody {
  group: THREE.Group;
  anatomy: Anatomy;
  coat: Coat;
  mesh: THREE.SkinnedMesh;
  shells: THREE.SkinnedMesh[];
  furUniforms: FurUniforms;
  skinUniforms: { uGlow: { value: number } };
  bones: Record<string, THREE.Bone>;
  rest: Record<string, THREE.Vector3>;
  eyes: { l: EyeRig; r: EyeRig };
  lantern: { mesh: THREE.Mesh; halo: THREE.Sprite; light: THREE.PointLight; uniforms: { uGlow: { value: number } } };
  mouth: { cavity: THREE.Mesh; tongue: THREE.Mesh };
  mouthSocket: THREE.Object3D;
  proxies: TouchProxy[];
  setShellCount(n: number): void;
  dispose(): void;
}

const v3 = (a: Vec3): THREE.Vector3 => new THREE.Vector3(a[0], a[1], a[2]);

export function buildKinling(look: Look, opts: { cell?: number; shells?: number } = {}): KinlingBody {
  const anatomy = buildAnatomy(look);
  const coat = coatFor(look);
  const cell = opts.cell ?? 0.0092;
  const { parts } = anatomy;

  // ── sculpt ───────────────────────────────────────────────────────
  const surf = extractSurface((x, y, z) => bodyDistance(parts, x, y, z), anatomy.bounds.min, anatomy.bounds.max, cell);
  const vcount = surf.positions.length / 3;

  // ── skeleton ─────────────────────────────────────────────────────
  const bones: Record<string, THREE.Bone> = {};
  const rest: Record<string, THREE.Vector3> = {};
  const boneList: THREE.Bone[] = [];
  const boneIndex = new Map<string, number>();
  for (const def of anatomy.bones) {
    const b = new THREE.Bone();
    b.name = def.name;
    rest[def.name] = v3(def.pos);
    const parentPos = def.parent ? rest[def.parent] : new THREE.Vector3();
    b.position.copy(rest[def.name]).sub(parentPos);
    if (def.parent) bones[def.parent].add(b);
    bones[def.name] = b;
    boneIndex.set(def.name, boneList.length);
    boneList.push(b);
  }

  // ── skin weights from the sculpt volumes ─────────────────────────
  const skinParts = parts.filter((p) => !p.subtract && !p.noSkin);
  const skinIdx = new Uint16Array(vcount * 4);
  const skinW = new Float32Array(vcount * 4);
  const wByBone = new Float32Array(boneList.length);
  for (let v = 0; v < vcount; v++) {
    const x = surf.positions[v * 3], y = surf.positions[v * 3 + 1], z = surf.positions[v * 3 + 2];
    wByBone.fill(0);
    for (const part of skinParts) {
      const d = Math.max(0, primDistance(part.prim, x, y, z));
      const sigma = 0.03 * (part.reach ?? 1);
      const w = Math.exp(-(d * d) / (sigma * sigma));
      const bi = boneIndex.get(part.bone)!;
      if (w > wByBone[bi]) wByBone[bi] = w;
    }
    let sum = 0;
    for (let s = 0; s < 4; s++) {
      let best = -1, bw = 1e-5;
      for (let b = 0; b < wByBone.length; b++) if (wByBone[b] > bw) { bw = wByBone[b]; best = b; }
      if (best < 0) break;
      skinIdx[v * 4 + s] = best;
      skinW[v * 4 + s] = bw;
      sum += bw;
      wByBone[best] = 0;
    }
    if (sum < 1e-5) { skinIdx[v * 4] = boneIndex.get('spine')!; skinW[v * 4] = 1; sum = 1; }
    for (let s = 0; s < 4; s++) skinW[v * 4 + s] /= sum;
  }

  // ── coat painting ────────────────────────────────────────────────
  const colors = new Float32Array(vcount * 3);
  const fur = new Float32Array(vcount); // strand length 0..1
  const glow = new Float32Array(vcount);
  const rng = new Rng(look.spotSeed);
  const spots: Array<{ p: THREE.Vector3; r: number }> = [];
  for (const side of [1, -1]) {
    const n = rng.int(3, 5);
    for (let i = 0; i < n; i++) {
      spots.push({
        p: new THREE.Vector3(side * rng.range(0.085, 0.13), rng.range(0.255, 0.35), rng.range(-0.25, -0.03)),
        r: rng.range(0.013, 0.023),
      });
    }
  }
  const tmp = new THREE.Color();
  const paint = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: THREE.Color): { fur: number; glow: number } => {
    const ax = Math.abs(x);
    let furLen = 0.82;
    let g = 0;
    const mott = fbm3(x * 22, y * 22, z * 22, 3, look.spotSeed);
    out.copy(coat.back);
    // dorsal stripe from brow to tail
    const dorsal = smoothstep(0.045, 0.012, ax) * smoothstep(0.35, 0.75, ny) * smoothstep(0.42, 0.3, z);
    out.lerp(coat.dark, dorsal * 0.55);
    // tail darkens toward the lantern
    const tailT = smoothstep(-0.3, -0.72, z);
    out.lerp(coat.dark, tailT * 0.7);
    furLen = lerp(furLen, 1.5, smoothstep(-0.27, -0.5, z));
    // countershading: cream underside, bib and inner legs
    const under = smoothstep(0.15, -0.55, ny) * smoothstep(-0.3, -0.2, z) * smoothstep(0.1, 0.16, y);
    const bib = 1 - smoothstep(0.07, 0.13, Math.hypot(x * 1.1, y - 0.255, (z - 0.215) * 1.15));
    const lowBelly = smoothstep(0.235, 0.19, y) * smoothstep(0.26, 0.12, Math.abs(z + 0.02)) * smoothstep(0.1, 0.05, ax);
    let cream = Math.max(under * 0.9, bib, lowBelly);
    // face: pale muzzle and chin, brow dots, light cheeks
    const muzzle = 1 - smoothstep(0.045, 0.075, Math.hypot(x * 0.95, (y - 0.418) * 1.25, z - 0.425));
    const browDot = 1 - smoothstep(0.012, 0.021, Math.hypot(ax - 0.04, y - 0.513, z - 0.413));
    const cheek = (1 - smoothstep(0.03, 0.085, Math.hypot(ax - 0.1, y - 0.405, z - 0.31))) * 0.75;
    cream = Math.max(cream, muzzle, browDot * look.mask, cheek);
    out.lerp(coat.belly, clamp01(cream));
    // dark mask swept back from the eyes
    const eyeMask = (1 - smoothstep(0.03, 0.062, Math.hypot(ax - 0.062, (y - 0.468) * 1.3, z - 0.385))) * (1 - muzzle) * (1 - browDot);
    out.lerp(coat.dark, eyeMask * 0.5 * look.mask);
    // paws
    const sock = smoothstep(0.085, 0.05, y);
    out.lerp(look.socks ? coat.belly : coat.dark, sock * 0.85);
    // haunch spots, faintly luminous
    for (const s of spots) {
      const d = Math.hypot(x - s.p.x, y - s.p.y, z - s.p.z);
      const k = 1 - smoothstep(s.r * 0.55, s.r, d);
      if (k > 0) { out.lerp(coat.belly, k * 0.9); g = Math.max(g, k * 0.5); }
    }
    // gentle mottling so the coat is never a flat fill
    const m = 0.9 + mott * 0.2;
    out.multiplyScalar(m);
    // strand length by region
    const face = 1 - smoothstep(0.05, 0.11, Math.hypot(x, y - 0.455, z - 0.4));
    furLen = lerp(furLen, 0.28, face);
    furLen = lerp(furLen, 0.1, 1 - smoothstep(0.012, 0.03, Math.hypot(x, y - 0.44, z - 0.455)));
    furLen = lerp(furLen, 0.12, 1 - smoothstep(0.036, 0.05, Math.hypot(ax - 0.05, y - 0.467, z - 0.392)));
    furLen = lerp(furLen, 0.34, smoothstep(0.1, 0.03, y));
    furLen = lerp(furLen, 0.55, smoothstep(0.2, 0.12, y) * smoothstep(0.03, 0.1, y));
    furLen = Math.max(furLen, bib * 1.0, cheek * 1.1);
    void nx; void nz;
    return { fur: Math.min(1.6, Math.max(0, furLen)), glow: g };
  };
  for (let v = 0; v < vcount; v++) {
    const i = v * 3;
    const r = paint(surf.positions[i], surf.positions[i + 1], surf.positions[i + 2], surf.normals[i], surf.normals[i + 1], surf.normals[i + 2], tmp);
    colors[i] = tmp.r; colors[i + 1] = tmp.g; colors[i + 2] = tmp.b;
    fur[v] = r.fur;
    glow[v] = r.glow;
  }

  // ── ears: lofted leaves, skinned to two bones each ───────────────
  const earPos: number[] = [], earNrm: number[] = [], earCol: number[] = [], earFur: number[] = [], earGlow: number[] = [];
  const earIdx: number[] = [], earSkinI: number[] = [], earSkinW: number[] = [];
  const U = 14, V = 8;
  const headI = boneIndex.get('head')!;
  for (const side of [1, -1]) {
    const b1 = side > 0 ? 'earL1' : 'earR1', b2 = side > 0 ? 'earL2' : 'earR2';
    const base = rest[b1].clone().add(new THREE.Vector3(-0.004 * side, -0.02, 0.004));
    const mid = rest[b2].clone();
    const tip = v3(side > 0 ? anatomy.earTips.l : anatomy.earTips.r);
    const ctrl = mid.clone().multiplyScalar(2).sub(base.clone().add(tip).multiplyScalar(0.5));
    const face = new THREE.Vector3(0.42 * side, 0.12, 0.9).normalize();
    const len = base.distanceTo(mid) + mid.distanceTo(tip);
    const wMax = len * 0.46;
    const startIndex = earPos.length / 3;
    const c = new THREE.Vector3(), t = new THREE.Vector3(), a = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
    for (let surfSide = 0; surfSide < 2; surfSide++) {
      for (let iu = 0; iu <= U; iu++) {
        const u = iu / U;
        const o = 1 - u;
        c.set(0, 0, 0).addScaledVector(base, o * o).addScaledVector(ctrl, 2 * o * u).addScaledVector(tip, u * u);
        t.set(0, 0, 0).addScaledVector(base, -2 * o).addScaledVector(ctrl, 2 * o - 2 * u).addScaledVector(tip, 2 * u).normalize();
        a.crossVectors(t, face).normalize();
        n.crossVectors(a, t).normalize();
        const w = wMax * (0.34 * o * o + Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.8)) * (u > 0.985 ? 0.3 : 1);
        for (let iv = 0; iv <= V; iv++) {
          const vv = (iv / V) * 2 - 1;
          const rim = 1 - vv * vv;
          const cup = -rim * w * 0.3;
          const thick = surfSide === 0 ? 0 : -Math.sqrt(rim) * 0.012 * (1 - 0.65 * u);
          p.copy(c).addScaledVector(a, vv * w * 0.5 * side).addScaledVector(n, cup + thick);
          earPos.push(p.x, p.y, p.z);
          earNrm.push(0, 0, 0);
          if (surfSide === 0) {
            tmp.copy(coat.earInner).lerp(coat.back, smoothstep(0.55, 1, Math.abs(vv)) * 0.9).lerp(coat.dark, smoothstep(0.7, 1, u) * 0.5);
            earFur.push(0.1 + 0.25 * smoothstep(0.4, 1, Math.abs(vv)));
            earGlow.push(0.12 * rim * (1 - u));
          } else {
            tmp.copy(coat.back).lerp(coat.dark, smoothstep(0.45, 0.95, u) * 0.8);
            earFur.push(0.42 * (1 - 0.5 * u));
            earGlow.push(0);
          }
          earCol.push(tmp.r, tmp.g, tmp.b);
          const w2 = smoothstep(0.25, 0.7, u);
          const wh = (1 - smoothstep(0, 0.2, u)) * 0.7;
          const w1 = Math.max(0, 1 - w2 - wh);
          earSkinI.push(headI, boneIndex.get(b1)!, boneIndex.get(b2)!, 0);
          earSkinW.push(wh, w1, w2, 0);
        }
      }
    }
    const row = V + 1;
    for (let surfSide = 0; surfSide < 2; surfSide++) {
      const off = startIndex + surfSide * (U + 1) * row;
      for (let iu = 0; iu < U; iu++)
        for (let iv = 0; iv < V; iv++) {
          const i0 = off + iu * row + iv, i1 = i0 + 1, i2 = i0 + row, i3 = i2 + 1;
          const flip = (surfSide === 0) === (side > 0);
          if (flip) earIdx.push(i0, i2, i1, i1, i2, i3);
          else earIdx.push(i0, i1, i2, i1, i3, i2);
        }
    }
  }
  // normals for the ear patch
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(earPos, 3));
    g.setIndex(earIdx);
    g.computeVertexNormals();
    const nn = g.getAttribute('normal').array as Float32Array;
    for (let i = 0; i < nn.length; i++) earNrm[i] = nn[i];
    g.dispose();
  }

  // ── merge into one skinned geometry ──────────────────────────────
  const ecount = earPos.length / 3;
  const total = vcount + ecount;
  const geo = new THREE.BufferGeometry();
  const cat = (a: Float32Array, b: number[], size: number): THREE.Float32BufferAttribute => {
    const out = new Float32Array(total * size);
    out.set(a, 0);
    out.set(b, a.length);
    return new THREE.Float32BufferAttribute(out, size);
  };
  geo.setAttribute('position', cat(surf.positions, earPos, 3));
  geo.setAttribute('normal', cat(surf.normals, earNrm, 3));
  geo.setAttribute('color', cat(colors, earCol, 3));
  geo.setAttribute('aFur', cat(fur, earFur, 1));
  geo.setAttribute('aGlow', cat(glow, earGlow, 1));
  const si = new Uint16Array(total * 4);
  si.set(skinIdx, 0);
  si.set(earSkinI, vcount * 4);
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', cat(skinW, earSkinW, 4));
  const index = new Uint32Array(surf.indices.length + earIdx.length);
  index.set(surf.indices, 0);
  for (let i = 0; i < earIdx.length; i++) index[surf.indices.length + i] = earIdx[i] + vcount;
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  geo.boundingSphere!.radius *= 1.6; // generous: the rig moves well beyond rest pose

  const skeleton = new THREE.Skeleton(boneList);
  const skin = createSkinMaterial(coat);
  const mesh = new THREE.SkinnedMesh(geo, skin.material);
  mesh.name = 'kinling-skin';
  mesh.add(bones.root);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'kinling';
  group.add(mesh);

  // ── fur shells ───────────────────────────────────────────────────
  const furMat = createFurShellMaterial(coat);
  const shells: THREE.SkinnedMesh[] = [];
  const setShellCount = (n: number): void => {
    for (const s of shells) { group.remove(s); (s.material as THREE.Material).dispose(); }
    shells.length = 0;
    for (let i = 1; i <= n; i++) {
      const m = furMat.make(i / n, n);
      const shell = new THREE.SkinnedMesh(geo, m);
      shell.bind(skeleton, mesh.bindMatrix);
      shell.frustumCulled = false;
      shell.receiveShadow = true;
      shell.renderOrder = i;
      shells.push(shell);
      group.add(shell);
    }
  };
  setShellCount(opts.shells ?? 12);

  // ── eyes ─────────────────────────────────────────────────────────
  const eyeColor = new THREE.Color(EYE_COLORS[Math.floor(look.eyeHue * EYE_COLORS.length) % EYE_COLORS.length]);
  const lidColor = new THREE.Color();
  const makeEye = (centre: Vec3, side: number): EyeRig => {
    const root = new THREE.Group();
    root.position.copy(v3(centre)).sub(rest.head);
    root.rotation.y = 0.2 * side; // eyes sit slightly outward on the skull
    const R = anatomy.eyes.radius;
    const eye = createEyeMaterial(eyeColor);
    const ballGeo = new THREE.SphereGeometry(R, 28, 20);
    const ball = new THREE.Mesh(ballGeo, eye.material);
    root.add(ball);
    paint(centre[0], centre[1] + 0.03, centre[2] + 0.01, 0, 1, 0, lidColor);
    const lidMat = new THREE.MeshStandardMaterial({ color: lidColor.clone().multiplyScalar(0.92), roughness: 0.9, vertexColors: true });
    const makeLid = (upper: boolean): THREE.Mesh => {
      const g = new THREE.SphereGeometry(R * 1.085, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
      if (!upper) g.rotateZ(Math.PI);
      // darken toward the lash line
      const pos = g.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const edge = 1 - Math.abs(pos.getY(i)) / (R * 1.085);
        const k = 1 - smoothstep(0.75, 1, edge) * 0.65;
        col[i * 3] = k; col[i * 3 + 1] = k; col[i * 3 + 2] = k;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, lidMat);
      m.castShadow = false;
      return m;
    };
    const upper = makeLid(true), lower = makeLid(false);
    upper.rotation.x = -0.72;
    lower.rotation.x = 0.95;
    root.add(upper, lower);
    bones.head.add(root);
    return { root, ball, upper, lower, uniforms: eye.uniforms };
  };
  const eyes = { l: makeEye(anatomy.eyes.l, 1), r: makeEye(anatomy.eyes.r, -1) };

  // ── nose and mouth ───────────────────────────────────────────────
  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshPhysicalMaterial({ color: coat.nose, roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
  );
  nose.scale.set(0.0155, 0.011, 0.01);
  nose.position.copy(v3(anatomy.nose)).sub(rest.head);
  bones.head.add(nose);
  const lipMat = new THREE.MeshStandardMaterial({ color: coat.nose.clone().multiplyScalar(1.4), roughness: 0.8 });
  for (const side of [1, -1]) {
    const pts = [
      new THREE.Vector3(0, 0.433, 0.4585),
      new THREE.Vector3(0.002 * side, 0.4225, 0.458),
      new THREE.Vector3(0.016 * side, 0.4165, 0.452),
      new THREE.Vector3(0.031 * side, 0.421, 0.44),
      new THREE.Vector3(0.039 * side, 0.428, 0.428),
    ].map((p) => p.sub(rest.head));
    const lip = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0021, 5), lipMat);
    bones.head.add(lip);
  }
  const cavity = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial({ color: 0x4a1c22, roughness: 0.7 }));
  cavity.position.set(0, 0.4135, 0.4465).sub(rest.head);
  cavity.scale.set(0.016, 0.0001, 0.008);
  bones.head.add(cavity);
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshStandardMaterial({ color: 0xe8848c, roughness: 0.5 }));
  tongue.position.set(0, 0.409, 0.448).sub(rest.head);
  tongue.scale.set(0.0001, 0.0001, 0.0001);
  bones.head.add(tongue);
  const mouthSocket = new THREE.Object3D();
  mouthSocket.position.set(0, 0.405, 0.475).sub(rest.head);
  bones.head.add(mouthSocket);

  // ── tail lantern ─────────────────────────────────────────────────
  const lastTail = bones[`tail${TAIL_BONES}`];
  const lm = createLanternMaterial(coat.lantern);
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 22; i++) {
    const t = i / 22;
    // a plump seed: round at the base, drawn to a soft point
    const r = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.85) * 0.05 * (1 - 0.3 * t * t);
    profile.push(new THREE.Vector2(Math.max(r, 0.0005), (t - 0.4) * 0.118));
  }
  const bud = new THREE.Mesh(new THREE.LatheGeometry(profile, 24), lm.material);
  bud.rotation.x = -Math.PI / 2 + 0.15; // the bud's axis follows the tail
  bud.position.copy(v3(anatomy.tailTip)).sub(rest[`tail${TAIL_BONES}`]);
  lastTail.add(bud);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: coat.lantern, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }));
  halo.scale.setScalar(0.42);
  bud.add(halo);
  const light = new THREE.PointLight(coat.lantern, 0.6, 2.6, 2);
  light.castShadow = false;
  bud.add(light);

  // ── touch proxies (coarse, bone-attached spheres for petting) ────
  const proxies: TouchProxy[] = [];
  const proxy = (boneName: string, world: Vec3, radius: number, region: TouchRegion): void => {
    proxies.push({ bone: bones[boneName], offset: v3(world).sub(rest[boneName]), radius, region });
  };
  proxy('head', [0, 0.475, 0.33], 0.105, 'head');
  proxy('head', [0, 0.418, 0.41], 0.055, 'chin');
  proxy('earL2', anatomy.earTips.l.map((v, i) => (v + rest.earL2.getComponent(i)) / 2) as Vec3, 0.07, 'ears');
  proxy('earR2', anatomy.earTips.r.map((v, i) => (v + rest.earR2.getComponent(i)) / 2) as Vec3, 0.07, 'ears');
  proxy('chest', [0, 0.3, 0.12], 0.125, 'back');
  proxy('spine', [0, 0.31, -0.02], 0.125, 'back');
  proxy('hips', [0, 0.29, -0.17], 0.125, 'back');
  proxy('spine', [0, 0.22, -0.02], 0.11, 'side');
  for (let i = 2; i <= TAIL_BONES; i++) proxy(`tail${i}`, [rest[`tail${i}`].x, rest[`tail${i}`].y, rest[`tail${i}`].z - 0.03], 0.06, 'tail');
  for (const id of ['fl', 'fr', 'hl', 'hr']) proxy(`${id}Paw`, [rest[`${id}Paw`].x, 0.04, rest[`${id}Paw`].z + 0.01], 0.055, 'paws');

  return {
    group, anatomy, coat, mesh, shells, bones, rest, eyes,
    furUniforms: furMat.uniforms,
    skinUniforms: skin.uniforms,
    lantern: { mesh: bud, halo, light, uniforms: lm.uniforms },
    mouth: { cavity, tongue },
    mouthSocket,
    proxies,
    setShellCount,
    dispose(): void {
      geo.dispose();
      skin.material.dispose();
      for (const s of shells) (s.material as THREE.Material).dispose();
      skeleton.dispose();
    },
  };
}

let _glow: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
  if (_glow) return _glow;
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      const a = Math.pow(clamp01(1 - d), 2.4);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  _glow = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  _glow.colorSpace = THREE.SRGBColorSpace;
  _glow.needsUpdate = true;
  return _glow;
}
