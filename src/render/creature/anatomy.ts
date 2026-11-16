/**
 * The Kinling's designed anatomy: a rest-pose skeleton and the sculpted
 * volumes that follow each bone. All bones rest with identity orientation
 * (their axes match model space), which keeps the procedural rig simple:
 * a bone's world rotation is just "how far it has turned from rest".
 *
 * The animal faces +Z, stands on y = 0.
 */
import type { Look } from '../../sim/identity';
import type { BodyPart, Vec3 } from './sdf';

export interface BoneDef {
  name: string;
  parent: string | null;
  pos: Vec3;
}

export const LEGS = ['fl', 'fr', 'hl', 'hr'] as const;
export type LegId = (typeof LEGS)[number];
export const TAIL_BONES = 7;

export interface Anatomy {
  bones: BoneDef[];
  parts: BodyPart[];
  /** Toe contact point of each leg at rest (model space). */
  toes: Record<LegId, Vec3>;
  eyes: { l: Vec3; r: Vec3; radius: number };
  nose: Vec3;
  mouth: Vec3;
  tailTip: Vec3;
  earTips: { l: Vec3; r: Vec3 };
  bounds: { min: Vec3; max: Vec3 };
}

const mirror = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function buildAnatomy(look: Look): Anatomy {
  const plump = look.plump;
  const bones: BoneDef[] = [];
  const parts: BodyPart[] = [];
  const bone = (name: string, parent: string | null, pos: Vec3): void => void bones.push({ name, parent, pos });

  // ── axial skeleton ──────────────────────────────────────────────
  const hips: Vec3 = [0, 0.285, -0.15];
  const spine: Vec3 = [0, 0.3, -0.01];
  const chest: Vec3 = [0, 0.295, 0.12];
  const neck: Vec3 = [0, 0.335, 0.2];
  const head: Vec3 = [0, 0.415, 0.275];
  const skull: Vec3 = [0, 0.455, 0.335];
  bone('root', null, [0, 0, 0]);
  bone('hips', 'root', hips);
  bone('spine', 'hips', spine);
  bone('chest', 'spine', chest);
  bone('neck', 'chest', neck);
  bone('head', 'neck', head);
  bone('jaw', 'head', [0, 0.412, 0.34]);

  const R = 0.106 * plump;
  parts.push({ prim: { type: 'cone', a: [0, 0.282, -0.17], b: [0, 0.292, -0.03], r1: R * 0.98, r2: R * 1.04 }, bone: 'hips', k: 0.03 });
  parts.push({ prim: { type: 'cone', a: [0, 0.292, -0.03], b: [0, 0.29, 0.08], r1: R * 1.04, r2: R * 1.02 }, bone: 'spine', k: 0.03 });
  parts.push({ prim: { type: 'ellipsoid', c: [0, 0.288, 0.115], r: [R * 0.98, R * 1.02, 0.12] }, bone: 'chest', k: 0.03 });
  // soft belly and rump
  parts.push({ prim: { type: 'ellipsoid', c: [0, 0.245, -0.04], r: [R * 0.9, 0.075, 0.15] }, bone: 'spine', k: 0.04, noSkin: true });
  parts.push({ prim: { type: 'sphere', c: [0, 0.285, -0.2], r: R * 0.9 }, bone: 'hips', k: 0.04 });
  // chest ruff: a proud fluffy bib
  parts.push({ prim: { type: 'ellipsoid', c: [0, 0.262, 0.2], r: [0.082, 0.088, 0.066] }, bone: 'chest', k: 0.045 });
  parts.push({ prim: { type: 'cone', a: [0, 0.31, 0.165], b: [0, 0.405, 0.275], r1: 0.086, r2: 0.074 }, bone: 'neck', k: 0.045 });

  // ── head ────────────────────────────────────────────────────────
  parts.push({ prim: { type: 'ellipsoid', c: skull, r: [0.101, 0.09, 0.1] }, bone: 'head', k: 0.03, reach: 0.6 });
  parts.push({ prim: { type: 'ellipsoid', c: [0, 0.432, 0.41], r: [0.05, 0.036, 0.048] }, bone: 'head', k: 0.035, reach: 0.6 });
  // brow, giving the eyes a shelf to sit under
  parts.push({ prim: { type: 'ellipsoid', c: [0, 0.502, 0.385], r: [0.074, 0.03, 0.04] }, bone: 'head', k: 0.04, noSkin: true });
  for (const s of [1, -1]) {
    // cheeks and their swept-back tufts
    parts.push({ prim: { type: 'ellipsoid', c: [0.064 * s, 0.428, 0.365], r: [0.046, 0.042, 0.05] }, bone: 'head', k: 0.035, noSkin: true });
    parts.push({ prim: { type: 'cone', a: [0.082 * s, 0.428, 0.335], b: [0.142 * s, 0.398, 0.285], r1: 0.034, r2: 0.007 }, bone: 'head', k: 0.03, noSkin: true });
    parts.push({ prim: { type: 'cone', a: [0.08 * s, 0.41, 0.33], b: [0.122 * s, 0.368, 0.3], r1: 0.028, r2: 0.006 }, bone: 'head', k: 0.025, noSkin: true });
    // mound the ears grow from
    parts.push({ prim: { type: 'sphere', c: [0.062 * s, 0.52, 0.305], r: 0.03 }, bone: 'head', k: 0.04, noSkin: true });
  }
  // forelock
  parts.push({ prim: { type: 'cone', a: [0, 0.535, 0.345], b: [0, 0.588, 0.318], r1: 0.03, r2: 0.006 }, bone: 'head', k: 0.03, noSkin: true });
  parts.push({ prim: { type: 'cone', a: [0.012, 0.535, 0.33], b: [0.03, 0.572, 0.292], r1: 0.024, r2: 0.005 }, bone: 'head', k: 0.025, noSkin: true });
  // chin, driven by the jaw
  parts.push({ prim: { type: 'ellipsoid', c: [0, 0.408, 0.395], r: [0.036, 0.022, 0.04] }, bone: 'jaw', k: 0.02, reach: 0.35 });

  const eyeR = 0.0335;
  const eyeL: Vec3 = [0.05, 0.467, 0.392];
  for (const e of [eyeL, mirror(eyeL)]) parts.push({ prim: { type: 'sphere', c: e, r: eyeR * 1.04 }, bone: 'head', k: 0.012, subtract: true });

  // ── ears (bones only; the leaves are lofted separately) ─────────
  const es = look.earScale;
  const earBase: Vec3 = [0.06, 0.522, 0.302];
  const earMid = add(earBase, [0.04 * es, 0.082 * es, -0.022 * es]);
  const earTip = add(earMid, [0.046 * es, 0.105 * es, -0.04 * es]);
  bone('earL1', 'head', earBase);
  bone('earL2', 'earL1', earMid);
  bone('earR1', 'head', mirror(earBase));
  bone('earR2', 'earR1', mirror(earMid));

  // ── tail and its lantern ────────────────────────────────────────
  const ts = look.tailScale;
  let prev = 'hips';
  let p: Vec3 = [0, 0.3, -0.265];
  const seg: Vec3 = [0, 0.012 * ts, -0.078 * ts];
  for (let i = 0; i < TAIL_BONES; i++) {
    const name = `tail${i + 1}`;
    bone(name, prev, p);
    const q = add(p, seg);
    const t0 = i / TAIL_BONES, t1 = (i + 1) / TAIL_BONES;
    const rad = (t: number): number => 0.05 - 0.02 * t + 0.014 * Math.max(0, t - 0.7) / 0.3;
    if (i < TAIL_BONES - 1) parts.push({ prim: { type: 'cone', a: p, b: q, r1: rad(t0), r2: rad(t1) }, bone: name, k: 0.006 });
    prev = name;
    p = q;
  }
  // the last bone carries the lantern bud; a fluffy collar closes the fur
  const lastStart = add(p, [-seg[0], -seg[1], -seg[2]]);
  parts.push({ prim: { type: 'sphere', c: mix(lastStart, p, 0.15), r: 0.047 }, bone: `tail${TAIL_BONES}`, k: 0.03 });
  const tailTip = mix(lastStart, p, 0.85);

  // ── legs ────────────────────────────────────────────────────────
  const toes = {} as Record<LegId, Vec3>;
  const leg = (id: LegId, side: number): void => {
    const front = id[0] === 'f';
    const m = (v: Vec3): Vec3 => [v[0] * side, v[1], v[2]];
    if (front) {
      const sh = m([0.08, 0.252, 0.132]);
      const el = m([0.088, 0.15, 0.098]);
      const wr = m([0.088, 0.05, 0.134]);
      const toe = m([0.088, 0, 0.176]);
      bone(`${id}Upper`, 'chest', sh);
      bone(`${id}Lower`, `${id}Upper`, el);
      bone(`${id}Paw`, `${id}Lower`, wr);
      parts.push({ prim: { type: 'ellipsoid', c: m([0.07, 0.25, 0.13]), r: [0.05, 0.07, 0.062] }, bone: `${id}Upper`, k: 0.04, reach: 0.55 });
      parts.push({ prim: { type: 'cone', a: sh, b: el, r1: 0.05, r2: 0.04 }, bone: `${id}Upper`, k: 0.03 });
      parts.push({ prim: { type: 'cone', a: el, b: wr, r1: 0.039, r2: 0.033 }, bone: `${id}Lower`, k: 0.022 });
      parts.push({ prim: { type: 'ellipsoid', c: m([0.088, 0.026, 0.148]), r: [0.038, 0.027, 0.046] }, bone: `${id}Paw`, k: 0.02 });
      toes[id] = toe;
    } else {
      const hp = m([0.088, 0.262, -0.165]);
      const kn = m([0.104, 0.155, -0.094]);
      const hk = m([0.1, 0.078, -0.192]);
      const toe = m([0.1, 0, -0.132]);
      bone(`${id}Upper`, 'hips', hp);
      bone(`${id}Lower`, `${id}Upper`, kn);
      bone(`${id}Paw`, `${id}Lower`, hk);
      // haunch: the big rounded thigh that reads from every angle
      parts.push({ prim: { type: 'ellipsoid', c: m([0.084, 0.235, -0.14]), r: [0.058, 0.088, 0.086] }, bone: `${id}Upper`, k: 0.045, reach: 0.55 });
      parts.push({ prim: { type: 'cone', a: hp, b: kn, r1: 0.058, r2: 0.045 }, bone: `${id}Upper`, k: 0.03 });
      parts.push({ prim: { type: 'cone', a: kn, b: hk, r1: 0.042, r2: 0.03 }, bone: `${id}Lower`, k: 0.022 });
      parts.push({ prim: { type: 'cone', a: hk, b: m([0.1, 0.03, -0.15]), r1: 0.029, r2: 0.03 }, bone: `${id}Paw`, k: 0.02 });
      parts.push({ prim: { type: 'ellipsoid', c: m([0.1, 0.025, -0.142]), r: [0.038, 0.026, 0.046] }, bone: `${id}Paw`, k: 0.02 });
      toes[id] = toe;
    }
  };
  leg('fl', 1);
  leg('fr', -1);
  leg('hl', 1);
  leg('hr', -1);

  return {
    bones,
    parts,
    toes,
    eyes: { l: eyeL, r: mirror(eyeL), radius: eyeR },
    nose: [0, 0.444, 0.457],
    mouth: [0, 0.418, 0.44],
    tailTip,
    earTips: { l: earTip, r: mirror(earTip) },
    bounds: { min: [-0.22, -0.03, -0.9 * Math.max(1, ts)], max: [0.22, 0.64, 0.5] },
  };
}
