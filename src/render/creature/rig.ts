/**
 * The performance system. Everything the body does on screen is derived here,
 * every frame, from the simulation's state: where the agent is and how fast
 * it is moving, what its body is engaged in, what it is attending to, how it
 * feels. Nothing here writes back to the simulation.
 *
 * Layers, in order:
 *   1. pose targets  (posture + action performance + emotion + touch) → springs
 *   2. gait          feet are planted in world space and step when the gait
 *                    clock says so; the body rides on them
 *   3. spine FK, leg IK, look-at for neck/head
 *   4. secondary     verlet chains for tail and ears
 *   5. face          eyes (saccades, lids, pupils), jaw, breath, lantern
 */
import * as THREE from 'three';
import { angleDelta, bump, clamp, clamp01, damp, easeInOut, easeOutBack, easeOutCubic, frac, lerp, smoothstep, Spring, window4 } from '../../core/math';
import { Rng } from '../../core/rng';
import type { Kinling } from '../../sim/creature/Kinling';
import { RUN_SPEED } from '../../sim/needs';
import { heightAt, normalAt, WATER_Y } from '../../sim/terrain';
import { LEGS, TAIL_BONES, type LegId } from './anatomy';
import type { KinlingBody } from './build';

const V = THREE.Vector3;
const Q = THREE.Quaternion;
const X = new V(1, 0, 0), Y = new V(0, 1, 0), Z = new V(0, 0, 1);
const _v1 = new V(), _v2 = new V(), _v3 = new V(), _v4 = new V();
const _q1 = new Q(), _q2 = new Q();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

/** Every animatable quantity the layers agree on. Targets are set each frame, springs smooth them. */
const CHANNELS = [
  'hipsY', 'chestY', 'bodyZ', 'bodyX', 'roll', 'twist', 'curl', 'arch',
  'neckPitch', 'headPitch', 'headRoll', 'headYaw', 'lookWeight',
  'earFwdL', 'earFwdR', 'earDroopL', 'earDroopR',
  'tailLift', 'tailCurl', 'tailWag', 'tailStiff',
  'lidUpper', 'lidLower', 'brow', 'pupil', 'jaw', 'tongue',
  'frontZ', 'frontX', 'hindZ', 'hindX', 'frontFlat', 'hindFlat',
  'fur', 'breath',
] as const;
type Channel = (typeof CHANNELS)[number];
type Pose = Record<Channel, number>;

const HALFLIFE: Partial<Record<Channel, number>> = {
  hipsY: 0.11, chestY: 0.11, bodyZ: 0.1, bodyX: 0.12, roll: 0.1, twist: 0.12, curl: 0.2, arch: 0.12,
  neckPitch: 0.1, headPitch: 0.09, headRoll: 0.1, headYaw: 0.1, lookWeight: 0.12,
  earFwdL: 0.07, earFwdR: 0.07, earDroopL: 0.12, earDroopR: 0.12,
  tailLift: 0.16, tailCurl: 0.25, tailWag: 0.2, tailStiff: 0.2,
  lidUpper: 0.05, lidLower: 0.08, brow: 0.1, pupil: 0.12, jaw: 0.04, tongue: 0.05,
  frontZ: 0.14, frontX: 0.14, hindZ: 0.14, hindX: 0.14, frontFlat: 0.14, hindFlat: 0.14,
  fur: 0.12, breath: 0.6,
};

function neutralPose(): Pose {
  const p = {} as Pose;
  for (const c of CHANNELS) p[c] = 0;
  p.lidUpper = 1;
  p.pupil = 0.52;
  p.lookWeight = 1;
  p.fur = 1;
  return p;
}

interface Foot {
  id: LegId;
  front: boolean;
  side: number;
  /** Current world position of the toe. */
  pos: THREE.Vector3;
  from: THREE.Vector3;
  planted: boolean;
  s: number;
  dur: number;
  lift: number;
  /** Height above the ground right now. */
  air: number;
  lastLand: number;
  prevPhase: number;
  /** Per-frame override used by paw gestures (model-space offset, 0..1 weight). */
  gesture: THREE.Vector3;
  gestureW: number;
  flying: boolean;
}

interface Chain {
  bones: string[];
  parent: string;
  /** Simulated joint positions in world space (one more than bones). */
  pts: THREE.Vector3[];
  prev: THREE.Vector3[];
  len: number[];
  restDir: THREE.Vector3[];
  stiffBase: number;
  stiffTip: number;
  damping: number;
  gravity: number;
  init: boolean;
}

export interface FootfallEvent { x: number; z: number; strength: number; wet: boolean; leg: LegId }

export class KinlingRig {
  readonly group: THREE.Group;
  onFootfall: ((e: FootfallEvent) => void) | null = null;
  /** Scales bounce and jiggle; lowered for reduced-motion. */
  motionScale = 1;

  private pose = neutralPose();
  private springs = {} as Record<Channel, Spring>;
  private D: Record<string, THREE.Quaternion> = {};
  private P: Record<string, THREE.Vector3> = {};
  private feet: Foot[] = [];
  private tail: Chain;
  private earL: Chain;
  private earR: Chain;
  private phase = 0;
  private time = 0;
  private yaw = 0;
  private spin = 0;
  private leapY = 0;
  private airborne = false;
  private prevSpeed = 0;
  private accelLean = new Spring(0, 0.16);
  private turnLean = new Spring(0, 0.14);
  private puff = 0;
  private breathPhase = 0;
  private blinkAt = 2;
  private blinkT = 1;
  private blinkDur = 0.14;
  private slowBlink = false;
  private eyeYaw = 0;
  private eyePitch = 0;
  private saccadeAt = 0;
  private saccade = new V();
  private idleLookAt = 3;
  private idleLook = new V();
  private idleLookUntil = 0;
  private earFlickAt = 4;
  private earFlick = { t: 1, side: 1 };
  private tailTwitch = 0;
  private lookTarget = new V();
  private lookSmooth = new V();
  private glow = 0.5;
  private glowPulse = 0;
  private lastActionSerial = -1;
  private tiltSide = 1;
  private rng: Rng;
  private shadowBody: THREE.Mesh;
  private shadowFeet: THREE.Mesh[] = [];
  private handed: number;
  private readonly rootInv = new THREE.Matrix4();
  private readonly qRoot = new Q();
  private readonly worldPos = new V();
  private camPos = new V();

  constructor(readonly body: KinlingBody, readonly k: Kinling, scene: THREE.Scene) {
    this.group = body.group;
    this.rng = new Rng(k.identity.seed).fork('rig');
    this.handed = this.rng.chance(0.5) ? 1 : -1;
    for (const c of CHANNELS) this.springs[c] = new Spring(this.pose[c], HALFLIFE[c] ?? 0.1);
    for (const name of Object.keys(body.bones)) { this.D[name] = new Q(); this.P[name] = body.rest[name].clone(); }

    this.yaw = k.heading;
    this.worldPos.set(k.position.x, k.position.y, k.position.z);
    for (const id of LEGS) {
      const toe = body.anatomy.toes[id];
      const home = this.homeWorld(id, toe[0], toe[2], this.worldPos, this.yaw);
      this.feet.push({
        id, front: id[0] === 'f', side: Math.sign(toe[0]), pos: home.clone(), from: home.clone(), planted: true,
        s: 1, dur: 0.2, lift: 0.03, air: 0, lastLand: -1, prevPhase: 0, gesture: new V(), gestureW: 0, flying: false,
      });
    }

    const tailBones = Array.from({ length: TAIL_BONES }, (_, i) => `tail${i + 1}`);
    this.tail = this.makeChain(tailBones, 'hips', body.anatomy.tailTip as [number, number, number], 0.34, 0.07, 0.86, 0.5);
    this.earL = this.makeChain(['earL1', 'earL2'], 'head', body.anatomy.earTips.l as [number, number, number], 0.5, 0.3, 0.72, 0);
    this.earR = this.makeChain(['earR1', 'earR2'], 'head', body.anatomy.earTips.r as [number, number, number], 0.5, 0.3, 0.72, 0);

    // contact shadows: a soft blob under the body and one under each paw
    const tex = blobTexture();
    const mk = (size: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: 0x05080a, opacity: 0.5, fog: false, toneMapped: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 2;
      scene.add(m);
      return m;
    };
    this.shadowBody = mk(0.62);
    for (let i = 0; i < 4; i++) this.shadowFeet.push(mk(0.13));
  }

  private makeChain(bones: string[], parent: string, tip: [number, number, number], stiffBase: number, stiffTip: number, damping: number, gravity: number): Chain {
    const rest = this.body.rest;
    const pts: THREE.Vector3[] = [], prev: THREE.Vector3[] = [], len: number[] = [], restDir: THREE.Vector3[] = [];
    for (let i = 0; i < bones.length; i++) {
      const a = rest[bones[i]];
      const b = i + 1 < bones.length ? rest[bones[i + 1]] : new V(tip[0], tip[1], tip[2]);
      pts.push(a.clone()); prev.push(a.clone());
      len.push(a.distanceTo(b));
      restDir.push(b.clone().sub(a).normalize());
      if (i === bones.length - 1) { pts.push(b.clone()); prev.push(b.clone()); }
    }
    return { bones, parent, pts, prev, len, restDir, stiffBase, stiffTip, damping, gravity, init: false };
  }

  private homeWorld(id: LegId, lx: number, lz: number, base: THREE.Vector3, yaw: number, out = new V()): THREE.Vector3 {
    const s = Math.sin(yaw), c = Math.cos(yaw);
    out.set(base.x + lx * c + lz * s, 0, base.z - lx * s + lz * c);
    out.y = heightAt(out.x, out.z);
    void id;
    return out;
  }

  /** After a teleport (load, return from absence): replant the paws and settle the chains. */
  snap(x: number, y: number, z: number): void {
    const toes = this.body.anatomy.toes;
    this.yaw = this.k.heading;
    this.worldPos.set(x, y, z);
    for (const f of this.feet) {
      this.homeWorld(f.id, toes[f.id][0], toes[f.id][2], this.worldPos, this.yaw, f.pos);
      f.from.copy(f.pos); f.planted = true; f.s = 1; f.air = 0; f.flying = false;
    }
    this.tail.init = this.earL.init = this.earR.init = false;
    this.lookSmooth.set(0, 0, 0);
    this.prevSpeed = this.k.speed;
  }

  /** World position of the mouth socket (where a carried toy sits). */
  mouthWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.body.mouthSocket.getWorldPosition(out);
  }
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.body.bones.head.getWorldPosition(out);
  }

  // ───────────────────────────────────────────────────────────────
  update(dt: number, x: number, y: number, z: number, camera: THREE.Camera): void {
    const k = this.k;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.camPos.copy(camera.position);
    const speed = k.speed;
    const accel = (speed - this.prevSpeed) / Math.max(dt, 1e-4);
    this.prevSpeed = speed;

    const target = neutralPose();
    this.spin = 0;
    this.leapY = 0;
    this.airborne = false;
    for (const f of this.feet) f.gestureW = 0;
    this.poseFromState(target, dt);
    this.poseFromAction(target);
    this.poseFromTouch(target);
    for (const c of CHANNELS) this.pose[c] = this.springs[c].update(target[c], dt);
    const p = this.pose;

    // root: the simulation's transform, plus purely visual spin and leap arcs
    this.yaw = k.heading + this.spin;
    this.worldPos.set(x, y + this.leapY, z);
    this.group.position.copy(this.worldPos);
    this.group.rotation.set(0, this.yaw, 0);
    this.group.updateMatrixWorld(true);
    this.rootInv.copy(this.group.matrixWorld).invert();
    this.qRoot.setFromAxisAngle(Y, this.yaw);

    this.updateGait(dt, speed, p);
    this.solveBody(dt, speed, accel, p);
    this.solveLegs(p);
    this.solveHead(dt, p);
    this.applyBones();
    this.updateChains(dt, speed, p);
    this.updateFace(dt, p);
    this.updateLantern(dt);
    this.updateShadows(p);
    this.body.furUniforms.uFurLength.value = 0.023 * p.fur;
    const sway = this.body.furUniforms.uSway.value;
    sway.set(-Math.sin(k.yawRate * 0.12) * 0.6, 0, -clamp(speed / RUN_SPEED, 0, 1) * 0.5 - clamp(accel * 0.02, -0.3, 0.3));
  }

  // ── layer 1: what the body should be doing ─────────────────────
  private poseFromState(t: Pose, dt: number): void {
    const k = this.k;
    const a = k.affect;
    const energy = k.needs.values.energy;
    const fatigue = smoothstep(0.45, 0.1, energy);
    const speedN = clamp01(k.speed / RUN_SPEED);
    const moving = smoothstep(0.03, 0.2, k.speed);

    // posture
    if (k.posture === 'sit') {
      t.hipsY = -0.118; t.chestY = 0.012; t.bodyZ = -0.015;
      t.hindZ = 0.085; t.hindX = 0.022; t.frontZ = -0.04; t.frontX = -0.012; t.hindFlat = 0.75;
      t.tailLift = -0.5; t.tailCurl = 0.75 * this.handed;
    } else if (k.posture === 'lie') {
      t.hipsY = -0.158; t.chestY = -0.146;
      t.hindZ = 0.12; t.hindX = 0.05; t.frontZ = 0.085; t.frontX = -0.018; t.hindFlat = 1; t.frontFlat = 1;
      t.tailLift = -0.5; t.tailCurl = 0.9 * this.handed;
      t.neckPitch = -0.12;
    } else if (k.posture === 'sleep') {
      t.hipsY = -0.165; t.chestY = -0.158;
      t.hindZ = 0.13; t.hindX = 0.05; t.frontZ = 0.05; t.frontX = -0.01; t.hindFlat = 1; t.frontFlat = 1;
      t.curl = 0.62 * this.handed;
      t.neckPitch = 0.62; t.headPitch = 0.3; t.headYaw = -0.75 * this.handed; t.headRoll = -0.35 * this.handed;
      t.lookWeight = 0;
      t.tailLift = -0.45; t.tailCurl = 1.75 * this.handed; t.tailStiff = 1;
      t.lidUpper = 0; t.lidLower = 0.25;
      t.earDroopL = t.earDroopR = 0.55; t.earFwdL = t.earFwdR = -0.3;
      t.breath = -0.5;
    }
    // rising from rest is slower when tired
    if (k.riseT > 0) { t.hipsY = Math.min(t.hipsY, -0.03); }

    // gait style
    if (k.posture === 'stand') {
      if (k.style === 'sneak') { t.hipsY -= 0.045 * moving; t.chestY -= 0.07 * moving; t.neckPitch += 0.12 * moving; t.tailLift -= 0.4 * moving; t.frontX += 0.012; }
      else if (k.style === 'cautious') { t.hipsY -= 0.02 * moving; t.chestY -= 0.03 * moving; t.bodyZ -= 0.02 * moving; t.neckPitch += 0.2 * moving; t.headPitch -= 0.22 * moving; t.tailLift -= 0.25 * moving; }
      else if (k.style === 'tired') { t.neckPitch += 0.3; t.headPitch -= 0.1; t.tailLift -= 0.35; }
      // speed stretches the body out and lays the ears back
      t.chestY -= 0.012 * speedN; t.neckPitch += 0.16 * speedN; t.headPitch -= 0.14 * speedN;
      t.earFwdL -= 0.5 * speedN; t.earFwdR -= 0.5 * speedN;
      t.tailLift += 0.25 * speedN + 0.2 * moving * a.arousal;
    }

    // emotion overlay
    const happy = clamp01(a.valence);
    const wary = a.wariness;
    const perk = clamp01(k.alert + a.interest * 0.6);
    t.hipsY += 0.008 * a.arousal - 0.035 * wary - 0.012 * fatigue;
    t.chestY += 0.01 * a.arousal - 0.03 * wary - 0.014 * fatigue;
    t.neckPitch += 0.28 * fatigue - 0.1 * perk + 0.1 * wary;
    t.headPitch += 0.08 * fatigue;
    t.earFwdL += 0.55 * perk - 0.9 * wary - 0.25 * fatigue;
    t.earFwdR += 0.55 * perk - 0.9 * wary - 0.25 * fatigue;
    t.earDroopL += 0.4 * fatigue + 0.2 * wary;
    t.earDroopR += 0.4 * fatigue + 0.2 * wary;
    t.tailLift += 0.35 * happy + 0.3 * perk - 0.75 * wary - 0.3 * fatigue;
    t.tailWag += (k.posture === 'sleep' ? 0 : 0.25 * happy + 0.35 * clamp01(a.arousal - 0.5) * happy);
    t.tailStiff += perk * 0.6;
    t.lidUpper += (k.posture === 'sleep' ? 0 : 0.2 * perk + 0.25 * wary - 0.42 * fatigue - 0.12 * happy * (1 - a.arousal));
    t.lidLower += 0.3 * happy * (1 - wary);
    t.brow += 0.3 * wary - 0.25 * fatigue;
    t.pupil += 0.12 * a.interest + 0.1 * a.arousal + 0.14 * k.world.night - 0.1 * wary + 0.1 * perk;
    t.fur += 0.3 * wary;

    // carrying something: head up, proud
    if (k.carrying) { t.neckPitch -= 0.14; t.headPitch -= 0.05; t.jaw = 0.32; t.tailLift += 0.3; }

    // the fright response
    const st = k.startle;
    if (st.phase === 'flinch') {
      t.hipsY -= 0.07; t.chestY -= 0.055; t.bodyZ -= 0.03;
      t.earFwdL = t.earFwdR = -1.3; t.lidUpper = 1.32; t.pupil = 0.3; t.tailLift = -0.9; t.fur = 1.5; t.neckPitch -= 0.12; t.jaw = 0.25;
    } else if (st.phase === 'watch') {
      t.hipsY -= 0.045; t.chestY -= 0.03; t.bodyZ -= 0.02;
      t.earFwdL = t.earFwdR = 0.5; t.lidUpper = 1.25; t.pupil = 0.66; t.tailLift = -0.55; t.tailStiff = 1; t.fur = 1.4;
    } else if (st.phase === 'recover') {
      const u = clamp01(st.t / 0.95);
      t.roll += Math.sin(u * 28) * 0.16 * bump(u) * this.motionScale;
      t.lidUpper = lerp(0.3, 1, u); t.fur = 1.2;
    }

    // exertion memory drives breathing
    this.puff = clamp01(this.puff + (speedN * speedN * 0.9 - 0.12) * dt);
    t.breath += this.puff;
  }

  // ── action performances ────────────────────────────────────────
  private poseFromAction(t: Pose): void {
    const k = this.k;
    const act = k.action;
    if (!act) return;
    if (act.serial !== this.lastActionSerial) {
      this.lastActionSerial = act.serial;
      this.tiltSide = this.rng.chance(0.5) ? 1 : -1;
    }
    const u = clamp01(act.t / act.duration);
    const s = act.t;
    const ms = this.motionScale;
    const foot = (id: LegId): Foot => this.feet[LEGS.indexOf(id)];
    const paw = this.handed > 0 ? foot('fl') : foot('fr');
    switch (act.kind) {
      case 'eat': {
        const w = window4(u, 0, 0.2, 0.86, 1);
        t.chestY -= 0.045 * w; t.neckPitch += 0.92 * w; t.headPitch += 0.42 * w; t.lookWeight = 1 - w;
        const chew = Math.max(0, Math.sin(s * 15)) * smoothstep(0.3, 0.4, u) * (1 - smoothstep(0.9, 1, u));
        t.jaw = 0.5 * chew + 0.5 * window4(u, 0.22, 0.3, 0.33, 0.4);
        t.headPitch -= 0.06 * chew;
        t.earFwdL -= 0.3 * w; t.earFwdR -= 0.3 * w; t.lidUpper -= 0.25 * w; t.tailWag += 0.25 * w;
        break;
      }
      case 'drink': {
        const w = window4(u, 0, 0.16, 0.88, 1);
        t.chestY -= 0.07 * w; t.hipsY -= 0.012 * w; t.neckPitch += 0.95 * w; t.headPitch += 0.4 * w; t.lookWeight = 1 - w;
        t.frontX += 0.02 * w;
        const lap = Math.max(0, Math.sin(s * 10.5 - 1.5)) * w;
        t.tongue = lap; t.jaw = 0.3 * w + 0.15 * lap; t.headPitch += 0.03 * lap;
        t.lidUpper -= 0.3 * w; t.earFwdL -= 0.2 * w; t.earFwdR -= 0.2 * w;
        break;
      }
      case 'sniff': {
        const w = window4(u, 0, 0.3, 0.8, 1);
        t.chestY -= 0.03 * w; t.neckPitch += 0.75 * w; t.headPitch += 0.3 * w + Math.sin(s * 30) * 0.035 * w; t.lookWeight = 1 - w * 0.8;
        t.earFwdL += 0.6 * w; t.earFwdR += 0.6 * w; t.tailStiff = 1; t.pupil += 0.1;
        break;
      }
      case 'pounce': {
        // crouch, spring, land. The simulation supplies the forward travel.
        const crouch = window4(act.t, 0, 0.1, 0.16, 0.24);
        const fly = clamp01((act.t - 0.16) / 0.3);
        const land = window4(act.t, 0.44, 0.5, 0.58, 0.8);
        t.hipsY -= 0.06 * crouch + 0.03 * land; t.chestY -= 0.08 * crouch + 0.07 * land; t.bodyZ -= 0.04 * crouch;
        if (act.t > 0.16 && act.t < 0.46) {
          this.airborne = true;
          this.leapY = 0.17 * Math.sin(fly * Math.PI) * (0.5 + 0.5 * ms);
          t.arch = -0.25 + 0.6 * fly; t.frontZ = 0.07 * (1 - fly) + 0.02; t.hindZ = -0.07 * (1 - fly);
          t.frontX -= 0.02;
        }
        t.earFwdL = t.earFwdR = 0.7 - 1.2 * bump(fly) * (this.airborne ? 1 : 0);
        t.tailLift += 0.6; t.pupil += 0.18; t.lidUpper += 0.15; t.neckPitch += 0.3 * land + 0.2 * (this.airborne ? fly : 0);
        break;
      }
      case 'pickup': {
        const w = window4(u, 0, 0.42, 0.62, 1);
        t.chestY -= 0.04 * w; t.neckPitch += 0.95 * w; t.headPitch += 0.38 * w; t.lookWeight = 1 - w;
        t.jaw = 0.75 * window4(u, 0.15, 0.4, 0.52, 0.6) + (u > 0.56 ? 0.32 : 0);
        break;
      }
      case 'drop': {
        const w = window4(u, 0, 0.4, 0.6, 1);
        t.chestY -= 0.03 * w; t.neckPitch += 0.7 * w; t.headPitch += 0.3 * w; t.lookWeight = 1 - w * 0.8;
        t.jaw = u < 0.5 ? 0.32 + 0.4 * smoothstep(0.3, 0.5, u) : 0.7 * (1 - smoothstep(0.5, 0.9, u));
        break;
      }
      case 'bat': {
        const w = window4(u, 0, 0.25, 0.75, 1);
        const swing = smoothstep(0.3, 0.52, u);
        t.bodyX -= 0.018 * w * paw.side; t.roll -= 0.06 * w * paw.side; t.chestY -= 0.02 * w;
        paw.gestureW = w;
        paw.gesture.set(-0.03 * paw.side * (1 - swing), 0.07 * bump(clamp01(u * 1.4)), -0.05 + 0.2 * swing);
        t.neckPitch += 0.4 * w; t.headPitch += 0.25 * w; t.earFwdL += 0.5; t.earFwdR += 0.5; t.tailLift += 0.4; t.tailWag += 0.3;
        break;
      }
      case 'gnaw': {
        const w = window4(u, 0, 0.12, 0.9, 1);
        t.neckPitch += 0.35 * w; t.headRoll += 0.3 * this.handed * w * Math.sin(s * 1.3);
        t.jaw = 0.32 + 0.25 * Math.max(0, Math.sin(s * 9)) * w; t.lidUpper -= 0.3 * w; t.tailWag += 0.2;
        break;
      }
      case 'playBow': {
        const w = window4(u, 0, 0.22, 0.8, 1);
        const bounce = Math.abs(Math.sin(s * 9)) * window4(u, 0.25, 0.35, 0.6, 0.75) * ms;
        t.chestY -= 0.125 * w - 0.02 * bounce; t.hipsY += 0.016 * w; t.bodyZ += 0.02 * w;
        t.frontZ += 0.075 * w; t.frontX += 0.02 * w; t.frontFlat = 0.6 * w;
        t.neckPitch -= 0.55 * w; t.headPitch -= 0.2 * w;
        t.tailLift += 1.0 * w; t.tailWag += 1.0 * w; t.earFwdL += 0.7 * w; t.earFwdR += 0.7 * w;
        t.lidLower += 0.4 * w; t.pupil += 0.15; t.jaw = 0.25 * w;
        break;
      }
      case 'stretch': {
        const a = window4(u, 0, 0.18, 0.42, 0.56); // front down, rump up
        const b = window4(u, 0.5, 0.66, 0.86, 1); // long forward stretch
        t.chestY -= 0.13 * a; t.hipsY += 0.02 * a - 0.03 * b; t.frontZ += 0.11 * a; t.frontFlat = 0.7 * a; t.bodyZ -= 0.03 * a - 0.05 * b;
        t.chestY += 0.015 * b; t.hindZ -= 0.1 * b; t.arch = 0.25 * a - 0.2 * b;
        t.neckPitch -= 0.5 * a + 0.25 * b; t.headPitch -= 0.15 * a;
        t.tailLift += 0.9 * a + 0.3 * b; t.tailStiff = 1; t.lidUpper -= 0.6 * a + 0.3 * b; t.lidLower += 0.4 * a;
        t.jaw = 0.5 * window4(u, 0.1, 0.22, 0.34, 0.45); t.earFwdL -= 0.6 * a; t.earFwdR -= 0.6 * a;
        break;
      }
      case 'shake': {
        const w = window4(u, 0.05, 0.2, 0.7, 0.95);
        const f = s * 34;
        t.roll += Math.sin(f - 0.9) * 0.2 * w * ms; t.headRoll += Math.sin(f) * 0.45 * w * ms; t.twist += Math.sin(f - 1.8) * 0.12 * w * ms;
        t.lidUpper = lerp(1, 0.05, w); t.lidLower += 0.5 * w; t.earDroopL += 0.3 * w; t.earDroopR += 0.3 * w; t.fur += 0.25 * w;
        t.hipsY -= 0.015 * w; t.chestY -= 0.015 * w;
        break;
      }
      case 'groom': {
        // lift a forepaw and wash it, with small licks
        const w = window4(u, 0, 0.18, 0.85, 1);
        paw.gestureW = w;
        paw.gesture.set(-0.045 * paw.side, 0.13 + 0.012 * Math.sin(s * 7), 0.07);
        t.bodyX -= 0.012 * paw.side * w; t.neckPitch += 0.62 * w; t.headPitch += 0.36 * w + 0.05 * Math.sin(s * 7) * w;
        t.headYaw += 0.3 * paw.side * w; t.headRoll -= 0.22 * paw.side * w; t.lookWeight = 1 - w;
        t.tongue = Math.max(0, Math.sin(s * 7)) * w * 0.9; t.jaw = 0.2 * w; t.lidUpper -= 0.45 * w;
        break;
      }
      case 'yawn': {
        const w = window4(u, 0.08, 0.38, 0.62, 0.92);
        t.jaw = 1.0 * w; t.tongue = 0.5 * w; t.neckPitch -= 0.42 * w; t.headPitch -= 0.26 * w; t.lookWeight = 1 - 0.7 * w;
        t.lidUpper = lerp(this.pose.lidUpper, 0.03, w); t.lidLower += 0.6 * w; t.earFwdL -= 0.9 * w; t.earFwdR -= 0.9 * w; t.headRoll += 0.08 * w;
        break;
      }
      case 'headTilt': {
        const w = window4(u, 0.05, 0.3, 0.75, 1);
        t.headRoll += 0.42 * w * this.tiltSide; t.earFwdL += 0.7 * w; t.earFwdR += 0.7 * w;
        // the signature: the lower ear folds a little
        if (this.tiltSide > 0) t.earDroopR += 0.5 * w; else t.earDroopL += 0.5 * w;
        t.pupil += 0.12 * w; t.lidUpper += 0.12 * w; t.tailStiff = 1;
        this.glowPulse = Math.max(this.glowPulse, 0.5 * w);
        break;
      }
      case 'knead': {
        // treading the bed: alternate forepaws press down, body rocks
        const w = window4(u, 0, 0.12, 0.9, 1);
        const ph = s * 5.2;
        const l = foot('fl'), r = foot('fr');
        l.gestureW = r.gestureW = w;
        l.gesture.set(0, 0.035 * Math.max(0, Math.sin(ph)), 0.012);
        r.gesture.set(0, 0.035 * Math.max(0, Math.sin(ph + Math.PI)), 0.012);
        t.roll += 0.05 * Math.sin(ph) * w; t.chestY -= 0.03 * w; t.neckPitch += 0.5 * w; t.headPitch += 0.2 * w; t.lookWeight = 1 - 0.8 * w;
        t.lidUpper -= 0.4 * w; t.tailWag += 0.2 * w; t.tailLift += 0.2 * w;
        break;
      }
      case 'chirp': {
        const w = window4(u, 0, 0.2, 0.5, 0.9);
        t.jaw = 0.55 * window4(u, 0.12, 0.25, 0.45, 0.65); t.neckPitch -= 0.2 * w; t.headPitch -= 0.1 * w;
        t.earFwdL += 0.5 * w; t.earFwdR += 0.5 * w;
        this.glowPulse = Math.max(this.glowPulse, 0.7 * w);
        break;
      }
      case 'greet': {
        const w = window4(u, 0, 0.1, 0.85, 1);
        const hop = Math.abs(Math.sin(s * 8.5)) * w * ms;
        t.chestY += 0.035 * hop; t.hipsY += 0.012 * hop; t.twist += Math.sin(s * 13) * 0.14 * w * ms; t.roll += Math.sin(s * 13 + 1) * 0.05 * w * ms;
        const l = foot('fl'), r = foot('fr');
        l.gestureW = r.gestureW = w * 0.9;
        l.gesture.set(0, 0.04 * Math.max(0, Math.sin(s * 8.5)), 0); r.gesture.set(0, 0.04 * Math.max(0, Math.sin(s * 8.5 + 1.2)), 0);
        t.neckPitch -= 0.35 * w; t.tailLift += 1.0 * w; t.tailWag += 1.2 * w; t.earFwdL += 0.4 * w; t.earFwdR += 0.4 * w;
        t.lidLower += 0.5 * w; t.jaw = 0.3 * w * Math.abs(Math.sin(s * 5));
        this.glowPulse = Math.max(this.glowPulse, w);
        break;
      }
      case 'wiggle': {
        const w = window4(u, 0, 0.25, 0.85, 1);
        t.hipsY -= 0.03 * w; t.chestY -= 0.075 * w; t.bodyZ -= 0.03 * w; t.neckPitch += 0.25 * w; t.headPitch -= 0.28 * w;
        t.twist += Math.sin(s * 26) * 0.13 * w * ms; t.bodyX += Math.sin(s * 26) * 0.006 * w;
        t.tailLift -= 0.2 * w; t.tailStiff = 1; this.tailTwitch = Math.max(this.tailTwitch, w);
        t.earFwdL += 0.8 * w; t.earFwdR += 0.8 * w; t.pupil += 0.2 * w; t.lidUpper += 0.1;
        break;
      }
      case 'pawAt': {
        const w = window4(u, 0.05, 0.28, 0.8, 1);
        paw.gestureW = w;
        paw.gesture.set(-0.02 * paw.side, 0.1 + 0.035 * Math.sin(s * 9), 0.08 + 0.04 * Math.sin(s * 9 + 1.5));
        t.bodyX -= 0.014 * paw.side * w; t.roll -= 0.04 * paw.side * w; t.headRoll += 0.12 * paw.side * w;
        t.earFwdL += 0.4 * w; t.earFwdR += 0.4 * w; t.lidLower += 0.2 * w;
        break;
      }
      case 'lookAway': {
        const w = window4(u, 0.1, 0.35, 0.8, 1);
        t.headYaw += 1.0 * this.tiltSide * w; t.lookWeight = 1 - w; t.neckPitch -= 0.1 * w; t.headPitch -= 0.1 * w;
        t.lidUpper -= 0.45 * w; t.earFwdL -= 0.4 * w; t.earFwdR -= 0.4 * w; t.tailWag = 0; this.tailTwitch = Math.max(this.tailTwitch, w * 0.6);
        break;
      }
      case 'perk': {
        const w = easeOutBack(clamp01(u * 2.5)) * (1 - smoothstep(0.7, 1, u));
        t.neckPitch -= 0.3 * w; t.hipsY += 0.012 * w; t.chestY += 0.02 * w; t.earFwdL += 0.9 * w; t.earFwdR += 0.9 * w; t.lidUpper += 0.2 * w; t.tailStiff = 1; t.tailLift += 0.3 * w;
        break;
      }
      case 'nuzzle': {
        const w = window4(u, 0, 0.3, 0.7, 1);
        t.bodyZ += 0.03 * w; t.neckPitch -= 0.2 * w; t.headRoll += 0.4 * this.tiltSide * Math.sin(u * Math.PI * 2) * w; t.lidUpper -= 0.6 * w; t.lidLower += 0.5 * w;
        break;
      }
      case 'spin': {
        // chasing its own tail: one full visual turn
        const e = easeInOut(clamp01((u - 0.08) / 0.8));
        this.spin = e * Math.PI * 2 * this.tiltSide;
        const w = window4(u, 0.05, 0.2, 0.8, 0.95);
        t.curl += 0.5 * this.tiltSide * w; t.headYaw += 0.8 * this.tiltSide * w; t.lookWeight = 1 - w; t.neckPitch += 0.2 * w;
        t.tailCurl += -0.9 * this.tiltSide * w; t.tailLift += 0.3 * w; t.chestY -= 0.02 * w; t.pupil += 0.15 * w;
        break;
      }
    }
  }

  // ── touch: lean into a hand it likes, flinch from one it does not ──
  private poseFromTouch(t: Pose): void {
    const k = this.k;
    const since = k.now - k.touch.at;
    if (since > 0.9 || k.posture === 'sleep') {
      if (since < 0.9 && k.posture === 'sleep') { t.tailWag += 0.12; t.lidLower += 0.3; }
      return;
    }
    const w = 1 - smoothstep(0.45, 0.9, since);
    const liked = k.touch.liked;
    _v1.set(k.touch.x, k.touch.y, k.touch.z).applyMatrix4(this.rootInv);
    const side = clamp(_v1.x * 9, -1, 1);
    const region = k.touch.region;
    if (liked >= 0) {
      const m = (0.45 + 0.55 * liked) * w;
      t.roll += -side * 0.11 * m; t.bodyX += side * 0.012 * m;
      t.lidUpper = lerp(t.lidUpper, 0.22, m); t.lidLower += 0.65 * m; t.brow -= 0.2 * m;
      t.earFwdL -= 0.5 * m; t.earFwdR -= 0.5 * m; t.earDroopL += 0.25 * m; t.earDroopR += 0.25 * m;
      t.tailLift += 0.45 * m; t.tailWag += 0.35 * m; t.lookWeight *= 1 - 0.7 * m;
      if (region === 'head' || region === 'ears') { t.neckPitch -= 0.14 * m; t.headRoll += -side * 0.3 * m; t.headPitch -= 0.08 * m; }
      else if (region === 'chin') { t.neckPitch -= 0.36 * m; t.headPitch -= 0.3 * m; }
      else if (region === 'back') { const rump = smoothstep(0.02, -0.14, _v1.z); t.hipsY += 0.028 * m * rump; t.chestY += 0.012 * m * (1 - rump); t.arch -= 0.12 * m; t.tailLift += 0.4 * m * rump; }
      else if (region === 'side') { t.roll += -side * 0.08 * m; }
    } else {
      const m = w * clamp01(-liked + 0.4);
      t.roll += side * 0.1 * m; t.bodyX -= side * 0.02 * m; t.earFwdL -= 1.0 * m; t.earFwdR -= 1.0 * m; t.lidUpper += 0.15 * m; t.brow += 0.4 * m;
      t.tailLift -= 0.35 * m; this.tailTwitch = Math.max(this.tailTwitch, m);
      if (region === 'paws') {
        let near = this.feet[0], nd = 1e9;
        for (const f of this.feet) { const d = f.pos.distanceToSquared(_v2.set(k.touch.x, k.touch.y, k.touch.z)); if (d < nd) { nd = d; near = f; } }
        near.gestureW = m; near.gesture.set(-0.02 * near.side, 0.06, near.front ? -0.05 : 0.05);
      }
    }
  }

  // ── layer 2: gait ──────────────────────────────────────────────
  private updateGait(dt: number, speed: number, p: Pose): void {
    const k = this.k;
    const toes = this.body.anatomy.toes;
    const standing = k.posture === 'stand';
    const v = speed;
    const moving = v > 0.06 && standing;
    const stride = clamp(0.22 + 0.36 * v, 0.2, 1.05) * (k.style === 'sneak' ? 0.8 : 1);
    const cycle = moving ? stride / Math.max(v, 0.06) : 1;
    const duty = lerp(0.68, 0.36, smoothstep(0.3, RUN_SPEED, v));
    if (moving) this.phase = frac(this.phase + dt / cycle);
    // phase offsets: lateral-sequence walk → diagonal trot → bounding run
    const trot = smoothstep(0.55, 0.95, v), bound = smoothstep(1.5, 1.95, v);
    const off: Record<LegId, number> = {
      hl: 0,
      fl: lerp(lerp(0.25, 0.5, trot), 0.5, bound),
      hr: lerp(0.5, 0.1, bound),
      fr: lerp(lerp(0.75, 1.0, trot), 0.6, bound),
    };
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const vx = k.velocity.x, vz = k.velocity.z;
    let swinging = 0;
    for (const f of this.feet) if (!f.planted) swinging++;

    // corrective stepping order when (nearly) still: worst foot first
    let worst: Foot | null = null, worstErr = 0;

    for (const f of this.feet) {
      const toe = toes[f.id];
      const lx = toe[0] + (f.front ? p.frontX : p.hindX) * f.side;
      const lz = toe[2] + (f.front ? p.frontZ : p.hindZ);
      const home = this.homeWorld(f.id, lx, lz, this.worldPos, this.yaw, _v1);

      if (this.airborne) {
        // in the air every paw travels with the body
        f.planted = false; f.flying = true; f.s = 1; f.pos.copy(home); f.pos.y = home.y + 0.05; f.air = 0.05;
        continue;
      }
      if (f.flying) {
        // touchdown after a leap
        f.flying = false; f.planted = true; f.air = 0; f.pos.copy(home); f.lastLand = this.time;
        if (f.front) this.onFootfall?.({ x: f.pos.x, z: f.pos.z, strength: 0.9, wet: home.y < WATER_Y + 0.01, leg: f.id });
      }

      const stanceT = duty * cycle;
      if (f.planted) {
        const err = Math.hypot(f.pos.x - home.x, f.pos.z - home.z);
        const local = frac(this.phase + off[f.id]);
        let lift = false;
        if (moving) {
          if (local < f.prevPhase && this.time - f.lastLand > 0.07) lift = true; // the gait clock says go
          if (err > 0.24) lift = true; // overstretched: step regardless
        } else if (err > worstErr) { worst = f; worstErr = err; }
        f.prevPhase = local;
        if (lift) {
          f.planted = false; f.s = 0; f.from.copy(f.pos);
          f.dur = clamp((1 - duty) * cycle, 0.09, 0.32);
          f.lift = lerp(0.028, 0.075, clamp01(v / RUN_SPEED)) * (k.style === 'sneak' ? 1.5 : 1) * (k.style === 'tired' ? 0.6 : 1);
          swinging++;
        }
      }
      if (!f.planted) {
        f.s += dt / Math.max(f.dur, 0.05);
        // land ahead of the hip so that mid-stance finds the paw beneath it
        const remain = Math.max(0, 1 - f.s) * f.dur;
        const lead = moving ? stanceT * 0.5 : 0;
        const yawF = k.yawRate * remain;
        const tx = home.x + vx * (remain + lead) + (-(home.z - this.worldPos.z)) * yawF * -1;
        const tz = home.z + vz * (remain + lead) + (home.x - this.worldPos.x) * yawF * -1;
        const e = easeInOut(clamp01(f.s));
        f.pos.x = lerp(f.from.x, tx, e);
        f.pos.z = lerp(f.from.z, tz, e);
        const ground = heightAt(f.pos.x, f.pos.z);
        f.air = f.lift * Math.pow(Math.sin(clamp01(f.s) * Math.PI), 0.85);
        f.pos.y = ground + f.air;
        if (f.s >= 1) {
          f.planted = true; f.air = 0; f.pos.y = ground; f.lastLand = this.time;
          swinging--;
          const wet = ground < WATER_Y + 0.01;
          this.onFootfall?.({ x: f.pos.x, z: f.pos.z, strength: clamp01(0.25 + v / RUN_SPEED), wet, leg: f.id });
        }
      } else {
        f.pos.y = heightAt(f.pos.x, f.pos.z);
        f.air = 0;
      }
    }
    // standing still (or settling into a rest pose): shuffle the worst-placed paw
    if (!moving && !this.airborne && worst && swinging === 0) {
      const threshold = standing ? 0.05 : 0.028;
      if (worstErr > threshold) {
        worst.planted = false; worst.s = 0; worst.from.copy(worst.pos);
        worst.dur = standing ? 0.2 : 0.3;
        worst.lift = standing ? 0.028 : 0.014;
      }
    }
    void sy; void cy;
  }

  // ── layer 3: spine ─────────────────────────────────────────────
  private solveBody(dt: number, speed: number, accel: number, p: Pose): void {
    const k = this.k;
    const rest = this.body.rest;
    const ms = this.motionScale;
    const fl = this.feet[0], fr = this.feet[1], hl = this.feet[2], hr = this.feet[3];
    // the body rides on its paws: lifted paws raise their end, uneven ground tilts it
    const gy = this.worldPos.y - this.leapY;
    const frontG = (fl.pos.y - fl.air + fr.pos.y - fr.air) / 2 - gy;
    const hindG = (hl.pos.y - hl.air + hr.pos.y - hr.air) / 2 - gy;
    const frontAir = (fl.air + fr.air) / 2, hindAir = (hl.air + hr.air) / 2;
    const speedN = clamp01(speed / RUN_SPEED);
    const stand = k.posture === 'stand' ? 1 : 0;
    const bound = smoothstep(1.5, 1.95, speed);
    // gait bob: twice per cycle at a walk/trot, a single arc when bounding
    const bob = (-Math.cos(this.phase * Math.PI * 4) * (0.004 + 0.011 * speedN) * (1 - bound) + Math.sin(this.phase * Math.PI * 2 + 0.6) * 0.022 * bound) * smoothstep(0.05, 0.3, speed) * ms * stand;
    const rock = Math.sin(this.phase * Math.PI * 2 - 0.5) * 0.11 * bound * ms * stand;

    const lean = this.accelLean.update(clamp(accel * 0.012, -0.045, 0.045), dt);
    const bank = this.turnLean.update(clamp(k.yawRate * 0.045 * (0.3 + speedN), -0.14, 0.14), dt);

    const hipsY = p.hipsY + hindG * 0.8 + hindAir * 0.4 * stand + bob + (this.leapY > 0 ? 0 : 0);
    const chestY = p.chestY + frontG * 0.8 + frontAir * 0.4 * stand + bob * 0.8;
    const L = rest.chest.z - rest.hips.z;
    const pitch = -Math.asin(clamp((chestY - hipsY) / L, -0.8, 0.8)) + rock - lean * 1.6;
    const roll = p.roll + bank + (hl.air - hr.air) * 0.9 * stand + (fl.air - fr.air) * 0.4 * stand;

    // hips
    this.P.root.set(0, 0, 0);
    this.D.root.identity();
    this.P.hips.copy(rest.hips).add(_v1.set(p.bodyX, hipsY, p.bodyZ - lean));
    this.D.hips.setFromEuler(_e.set(pitch + p.arch * 0.5, -p.curl * 0.55 - p.twist * 0.5 - k.yawRate * 0.02, roll, 'YXZ'));
    // spine and chest bend toward the turn, and carry the curl
    const bend = k.yawRate * 0.055 * stand;
    this.fk('spine', 'hips', _q1.setFromEuler(_e.set(-p.arch * 0.5, p.curl * 0.55 + p.twist * 0.5 + bend, 0, 'YXZ')));
    this.fk('chest', 'spine', _q1.setFromEuler(_e.set(-p.arch * 0.5, p.curl * 0.55 + p.twist * 0.5 + bend, -roll * 0.35, 'YXZ')));
  }

  /** Place a bone from its parent and a rotation relative to the parent. */
  private fk(name: string, parent: string, local: THREE.Quaternion): void {
    const rest = this.body.rest;
    this.D[name].copy(this.D[parent]).multiply(local);
    this.P[name].copy(rest[name]).sub(rest[parent]).applyQuaternion(this.D[parent]).add(this.P[parent]);
  }

  // ── leg IK ─────────────────────────────────────────────────────
  private solveLegs(p: Pose): void {
    const rest = this.body.rest;
    const toes = this.body.anatomy.toes;
    for (const f of this.feet) {
      const up = `${f.id}Upper`, lo = `${f.id}Lower`, pw = `${f.id}Paw`;
      const parent = f.front ? 'chest' : 'hips';
      // hip/shoulder follows the body
      const A = this.P[up].copy(rest[up]).sub(rest[parent]).applyQuaternion(this.D[parent]).add(this.P[parent]);
      // toe target in model space
      const toe = _v1.copy(f.pos).applyMatrix4(this.rootInv);
      if (f.gestureW > 0) {
        const tr = toes[f.id];
        _v2.set(tr[0], tr[1], tr[2]).add(f.gesture);
        toe.lerp(_v2, f.gestureW);
      }
      // foot attitude: heel rises through the swing; lies flat when resting
      const flat = f.front ? p.frontFlat : p.hindFlat;
      const swing = f.planted ? 0 : Math.sin(clamp01(f.s) * Math.PI);
      const footPitch = swing * (f.front ? 0.55 : 0.5) - flat * (f.front ? 0.78 : 0.72) + (f.gestureW > 0 && f.front ? 0.6 * f.gestureW : 0);
      const restToe = _v2.set(toes[f.id][0], toes[f.id][1], toes[f.id][2]);
      const footVec = _v3.copy(restToe).sub(rest[pw]);
      _q1.setFromAxisAngle(X, footPitch);
      footVec.applyQuaternion(_q1);
      const C = _v4.copy(toe).sub(footVec); // ankle / wrist
      C.y = Math.max(C.y, toe.y + 0.012);

      const l1 = rest[up].distanceTo(rest[lo]);
      const l2 = rest[lo].distanceTo(rest[pw]);
      const dir = _v2.copy(C).sub(A);
      let d = dir.length();
      const max = (l1 + l2) * 0.995, min = Math.abs(l1 - l2) + 0.012;
      d = clamp(d, min, max);
      dir.normalize();
      // elbows point back, knees point forward; both splay out a little when folded
      const fold = 1 - d / max;
      const pole = _v3.set(f.side * (0.15 + 1.1 * fold), f.front ? 0.2 * fold : 0.35 * fold, f.front ? -1 : 1);
      pole.addScaledVector(dir, -pole.dot(dir)).normalize();
      const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
      const B = this.P[lo].copy(A).addScaledVector(dir, a).addScaledVector(pole, h);
      const Cc = this.P[pw].copy(A).addScaledVector(dir, d);

      this.aim(this.D[up], rest[up], rest[lo], rest[pw], A, B, Cc, true);
      this.aim(this.D[lo], rest[lo], rest[pw], rest[up], B, Cc, A, false);
      this.D[pw].setFromAxisAngle(X, footPitch);
    }
  }

  /**
   * Rotation taking a bone from rest to its solved direction, keeping the
   * limb's bend plane consistent so there is no twist popping.
   */
  private aim(out: THREE.Quaternion, r0: THREE.Vector3, r1: THREE.Vector3, rRef: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, ref: THREE.Vector3, _upper: boolean): void {
    const basis = (o: THREE.Vector3, tip: THREE.Vector3, other: THREE.Vector3, m: THREE.Matrix4): void => {
      const y = _b1.copy(tip).sub(o).normalize();
      const n = _b2.copy(other).sub(o).cross(y);
      if (n.lengthSq() < 1e-10) n.set(1, 0, 0);
      n.normalize();
      const z = _b3.crossVectors(n, y);
      m.makeBasis(n, y, z);
    };
    basis(r0, r1, rRef, _mA);
    basis(a, b, ref, _mB);
    _mA.transpose();
    _m.multiplyMatrices(_mB, _mA);
    out.setFromRotationMatrix(_m);
  }

  // ── neck and head ──────────────────────────────────────────────
  private solveHead(dt: number, p: Pose): void {
    const k = this.k;
    // choose what to look at
    const g = k.gaze;
    const head = _v1.copy(this.body.rest.neck).sub(this.body.rest.chest).applyQuaternion(this.D.chest).add(this.P.chest).applyMatrix4(this.group.matrixWorld);
    let has = false;
    if (g.active) { this.lookTarget.set(g.x, g.y, g.z); has = true; }
    else if (k.travel.kind !== 'none' && k.speed > 0.1) {
      // watch where it is going, leading into turns
      const a = this.yaw + k.yawRate * 0.35;
      this.lookTarget.set(this.worldPos.x + Math.sin(a) * 2.5, this.worldPos.y + 0.25, this.worldPos.z + Math.cos(a) * 2.5);
      has = true;
    } else {
      // idle attention: now and then something catches its eye — sometimes you
      if (this.time > this.idleLookAt) {
        this.idleLookAt = this.time + 2.5 + this.rng.range(0, 5);
        this.idleLookUntil = this.time + 1 + this.rng.range(0, 2.2);
        const toCam = Math.atan2(this.camPos.x - this.worldPos.x, this.camPos.z - this.worldPos.z);
        const camVisible = Math.abs(angleDelta(this.yaw, toCam)) < 1.5;
        if (camVisible && this.rng.chance(0.3 + 0.4 * k.learn.data.bond)) this.idleLook.copy(this.camPos);
        else {
          const a = this.yaw + this.rng.range(-1.3, 1.3);
          this.idleLook.set(this.worldPos.x + Math.sin(a) * 3, this.worldPos.y + this.rng.range(0.05, 1.3), this.worldPos.z + Math.cos(a) * 3);
        }
      }
      if (this.time < this.idleLookUntil) { this.lookTarget.copy(this.idleLook); has = true; }
    }
    if (!has) this.lookTarget.set(this.worldPos.x + Math.sin(this.yaw) * 3, this.worldPos.y + 0.32, this.worldPos.z + Math.cos(this.yaw) * 3);
    if (this.lookSmooth.lengthSq() === 0) this.lookSmooth.copy(this.lookTarget);
    // eyes get there first (see updateFace); the head follows with weight
    const rate = 5 + 5 * k.affect.arousal + (k.startle.phase !== 'none' ? 10 : 0);
    this.lookSmooth.x = damp(this.lookSmooth.x, this.lookTarget.x, rate, dt);
    this.lookSmooth.y = damp(this.lookSmooth.y, this.lookTarget.y, rate, dt);
    this.lookSmooth.z = damp(this.lookSmooth.z, this.lookTarget.z, rate, dt);

    // direction to the target in the chest's frame
    const chestWorld = _q1.copy(this.qRoot).multiply(this.D.chest);
    const dir = _v2.copy(this.lookSmooth).sub(head).normalize().applyQuaternion(_q2.copy(chestWorld).invert());
    let yaw = Math.atan2(dir.x, dir.z);
    let pitch = -Math.asin(clamp(dir.y, -1, 1));
    // the body's own pitch should not drag the gaze with it
    yaw = clamp(yaw, -1.5, 1.5) * p.lookWeight;
    pitch = clamp(pitch, -0.9, 1.0) * p.lookWeight;
    yaw += p.headYaw;
    const np = pitch * 0.45 + p.neckPitch, hp = pitch * 0.55 + p.headPitch;
    this.fk('neck', 'chest', _q1.setFromEuler(_e.set(np, yaw * 0.42, -yaw * 0.08, 'YXZ')));
    this.fk('head', 'neck', _q1.setFromEuler(_e.set(hp, yaw * 0.58, p.headRoll + yaw * 0.06, 'YXZ')));
    this.fk('jaw', 'head', _q1.setFromAxisAngle(X, p.jaw * 0.42));
  }

  private applyBones(): void {
    const bones = this.body.bones;
    const defs = this.body.anatomy.bones;
    bones.hips.position.copy(this.P.hips);
    for (const def of defs) {
      if (def.name === 'root' || def.name.startsWith('tail') || def.name.startsWith('ear')) continue;
      const parent = def.parent!;
      bones[def.name].quaternion.copy(_q1.copy(this.D[parent]).invert()).multiply(this.D[def.name]);
    }
    bones.root.updateMatrixWorld(true);
  }

  // ── layer 4: tail and ears ─────────────────────────────────────
  private updateChains(dt: number, speed: number, p: Pose): void {
    const k = this.k;
    const t = this.time;
    const bones = this.body.bones;
    const n = TAIL_BONES;
    // tail: build the animated pose, then let the chain chase it
    this.tailTwitch = damp(this.tailTwitch, 0, 3, dt);
    const wagF = 5.5 + 5 * clamp01(p.tailWag);
    const tailLocal: THREE.Quaternion[] = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 1) / n;
      // a relaxed tail carries a gentle upward S; mood lifts or tucks it
      const lift = 0.1 * (1 - u) + 0.16 * u * u + p.tailLift * (0.3 * (1 - u * 0.5)) - Math.max(0, -p.tailLift) * 0.12 * u;
      const wag = Math.sin(t * wagF - u * 2.2) * p.tailWag * 0.26 * (0.4 + u) * this.motionScale;
      const twitch = i >= n - 2 ? Math.sin(t * 17) * 0.35 * this.tailTwitch : 0;
      const sway = Math.sin(t * 0.9 - u * 1.6) * 0.045 * (1 - clamp01(p.tailStiff));
      const curl = (p.tailCurl / n) * 1.25 * (0.6 + 0.8 * u);
      tailLocal.push(new Q().setFromEuler(_e.set(lift, curl + wag + twitch + sway + k.yawRate * -0.03 * u, 0, 'YXZ')));
    }
    this.simulateChain(this.tail, dt, tailLocal, 1 - 0.6 * clamp01(p.tailStiff));

    // ears: swivel, prick, flatten, droop — and the occasional flick
    if (t > this.earFlickAt) {
      this.earFlickAt = t + 3 + this.rng.range(0, 7);
      this.earFlick = { t: 0, side: this.rng.chance(0.5) ? 1 : -1 };
    }
    this.earFlick.t += dt * 7;
    const flick = this.earFlick.t < 1 ? Math.sin(this.earFlick.t * Math.PI * 2) * 0.5 : 0;
    // the ear nearer a sound or sight turns toward it
    _v1.copy(this.lookTarget).applyMatrix4(this.rootInv);
    const toSide = clamp(Math.atan2(_v1.x, _v1.z) * 0.5, -0.5, 0.5);
    const earPose = (side: number, fwd: number, droop: number): THREE.Quaternion[] => {
      const f = fwd + (this.earFlick.side === side ? flick : 0);
      const swivel = toSide * (side > 0 ? 1 : 1) * clamp01(k.alert + 0.3);
      const base = new Q().setFromEuler(_e.set(-f * 0.42 + 0.05, swivel * 0.6, -side * (droop * 0.85 + Math.max(0, -f) * 0.25), 'YXZ'));
      const tip = new Q().setFromEuler(_e.set(-f * 0.2 + droop * 0.5, 0, -side * droop * 0.7, 'YXZ'));
      return [base, tip];
    };
    this.simulateChain(this.earL, dt, earPose(1, p.earFwdL, p.earDroopL), 1);
    this.simulateChain(this.earR, dt, earPose(-1, p.earFwdR, p.earDroopR), 1);
    bones.root.updateMatrixWorld(true);
    void speed;
  }

  /**
   * Verlet chain in world space. Each joint is pulled toward where the
   * animated pose would put it, so the chain leads with intent but lags and
   * overshoots with the body's motion.
   */
  private simulateChain(c: Chain, dt: number, local: THREE.Quaternion[], looseness: number): void {
    const bones = this.body.bones;
    const rest = this.body.rest;
    const parentBone = bones[c.parent];
    const parentQ = parentBone.getWorldQuaternion(_cq);
    const origin = _co.copy(rest[c.bones[0]]).sub(rest[c.parent]);
    parentBone.localToWorld(origin);
    const nb = c.bones.length;
    // animated target joints
    let q = _cq2.copy(parentQ);
    const targets = _ct;
    targets[0].copy(origin);
    for (let i = 0; i < nb; i++) {
      q = q.multiply(local[i]);
      targets[i + 1].copy(c.restDir[i]).applyQuaternion(q).multiplyScalar(c.len[i]).add(targets[i]);
    }
    if (!c.init || c.pts[0].distanceToSquared(origin) > 1) {
      for (let i = 0; i <= nb; i++) { c.pts[i].copy(targets[i]); c.prev[i].copy(targets[i]); }
      c.init = true;
    }
    const steps = Math.max(1, Math.min(4, Math.ceil(dt / (1 / 90))));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      c.pts[0].copy(origin); c.prev[0].copy(origin);
      for (let i = 1; i <= nb; i++) {
        const u = i / nb;
        const pt = c.pts[i], pv = c.prev[i];
        const vx = (pt.x - pv.x) * c.damping, vy = (pt.y - pv.y) * c.damping, vz = (pt.z - pv.z) * c.damping;
        pv.copy(pt);
        pt.x += vx; pt.y += vy - c.gravity * h * h * u; pt.z += vz;
        const stiff = lerp(c.stiffBase, c.stiffTip, u) * (1.3 - 0.6 * looseness) * (h * 90) * (2 - this.motionScale);
        pt.lerp(targets[i], clamp01(stiff));
        // keep bone length
        const prevPt = c.pts[i - 1];
        const d = _v1.copy(pt).sub(prevPt);
        const l = d.length() || 1e-5;
        pt.copy(prevPt).addScaledVector(d, c.len[i - 1] / l);
        // stay above the ground
        const gy = heightAt(pt.x, pt.z) + 0.03;
        if (pt.y < gy) pt.y = gy;
      }
    }
    // joints → bone rotations
    let pq = _cq2.copy(parentQ);
    for (let i = 0; i < nb; i++) {
      const dirRest = _v1.copy(c.restDir[i]).applyQuaternion(pq);
      const dirNow = _v2.copy(c.pts[i + 1]).sub(c.pts[i]).normalize();
      const swing = _cq3.setFromUnitVectors(dirRest, dirNow);
      const world = _cq4.copy(swing).multiply(pq);
      bones[c.bones[i]].quaternion.copy(_q1.copy(pq).invert()).multiply(world);
      pq = pq.copy(world);
    }
  }

  // ── layer 5: face ──────────────────────────────────────────────
  private updateFace(dt: number, p: Pose): void {
    const k = this.k;
    const body = this.body;
    // blinking: irregular, with slow blinks when content and when attention shifts
    this.blinkT += dt / this.blinkDur;
    if (this.time > this.blinkAt && k.posture !== 'sleep') {
      const content = k.affect.valence > 0.3 && k.affect.arousal < 0.5 && k.affect.wariness < 0.1;
      this.slowBlink = content && this.rng.chance(0.3);
      this.blinkDur = this.slowBlink ? 0.75 : 0.13 + this.rng.range(0, 0.05);
      this.blinkT = 0;
      const sleepy = smoothstep(0.4, 0.1, k.needs.values.energy);
      this.blinkAt = this.time + (1.6 + this.rng.range(0, 4.5)) * (1 - 0.5 * sleepy) * (1 + k.alert);
      if (this.rng.chance(0.15)) this.blinkAt = this.time + 0.3; // a double blink
    }
    const blink = this.blinkT < 1 ? Math.sin(this.blinkT * Math.PI) : 0;
    const open = clamp(p.lidUpper, 0, 1.35) * (1 - blink * 0.98);
    // lids: rotate spherical caps over the eye. -0.72 is the relaxed open angle.
    const upper = lerp(0.42, -0.72, clamp01(open)) - Math.max(0, open - 1) * 0.5;
    const lower = Math.max(0.3, lerp(0.95, 0.5, clamp01(p.lidLower)) - (1 - clamp01(open)) * 0.55);

    // eyes: quick saccades to the target with tiny fixational drift
    if (this.time > this.saccadeAt) {
      this.saccadeAt = this.time + 0.25 + this.rng.range(0, 0.9);
      this.saccade.set(this.rng.range(-1, 1), this.rng.range(-1, 1), 0).multiplyScalar(0.04 + 0.06 * k.affect.interest);
    }
    const headQ = body.bones.head.getWorldQuaternion(_q1).invert();
    for (const side of [1, -1]) {
      const eye = side > 0 ? body.eyes.l : body.eyes.r;
      eye.root.getWorldPosition(_v1);
      const dir = _v2.copy(this.lookTarget).sub(_v1).normalize().applyQuaternion(headQ);
      let yaw = Math.atan2(dir.x, dir.z) - 0.2 * side;
      let pitch = -Math.asin(clamp(dir.y, -1, 1));
      yaw = clamp(yaw + this.saccade.x, -0.5, 0.5) * p.lookWeight;
      pitch = clamp(pitch + this.saccade.y, -0.38, 0.42) * p.lookWeight;
      if (side > 0) {
        this.eyeYaw = damp(this.eyeYaw, yaw + 0.2, 38, dt);
        this.eyePitch = damp(this.eyePitch, pitch, 38, dt);
      }
      // both eyes converge on the same point; they share the smoothed angles
      eye.ball.rotation.set(this.eyePitch, this.eyeYaw - 0.2 * side, 0);
      eye.upper.rotation.set(upper + this.eyePitch * 0.35, 0, -p.brow * 0.3 * side);
      eye.lower.rotation.set(lower + this.eyePitch * 0.2, 0, 0);
      eye.uniforms.uPupil.value = clamp(p.pupil, 0.22, 0.8);
      eye.uniforms.uGlint.value = clamp01(open * 1.4);
    }

    // mouth
    const jaw = clamp01(p.jaw);
    body.mouth.cavity.scale.set(0.014 + 0.004 * jaw, Math.max(0.0001, 0.013 * jaw), 0.008);
    body.mouth.cavity.position.y = 0.4135 - body.rest.head.y - 0.008 * jaw;
    const tongue = clamp01(p.tongue);
    body.mouth.tongue.scale.set(0.0075 * (tongue > 0.02 ? 1 : 0.001), 0.003 * (tongue > 0.02 ? 1 : 0.001), Math.max(0.0001, 0.02 * tongue));
    body.mouth.tongue.position.set(0, 0.409 - body.rest.head.y - 0.012 * jaw - 0.012 * tongue, 0.452 + 0.012 * tongue - body.rest.head.z);

    // breath: the ribcage swells; quicker after exertion, slow and deep asleep
    const rate = k.posture === 'sleep' ? 0.3 : 0.55 + 2.4 * clamp01(p.breath);
    this.breathPhase += dt * rate * Math.PI * 2;
    const depth = k.posture === 'sleep' ? 0.034 : 0.014 + 0.02 * clamp01(p.breath);
    const b = Math.sin(this.breathPhase) * depth;
    // swell the ribcage without scaling what hangs from it
    const sx = 1 + b * 0.6, sy = 1 + b * 0.5, cx = 1 + b, cy = 1 + b * 0.8;
    body.bones.spine.scale.set(sx, sy, 1);
    body.bones.chest.scale.set(cx / sx, cy / sy, 1);
    for (const n of ['neck', 'flUpper', 'frUpper']) body.bones[n].scale.set(1 / cx, 1 / cy, 1);
  }

  private updateLantern(dt: number): void {
    const k = this.k;
    this.glowPulse = damp(this.glowPulse, 0, 2.2, dt);
    const flicker = k.startle.phase === 'flinch' ? Math.random() * 0.8 : 0;
    const targetGlow = clamp(k.glow + this.glowPulse * 0.7 + flicker, 0.05, 1.6);
    this.glow = damp(this.glow, targetGlow, 5, dt);
    const night = k.world.night;
    const g = this.glow * (0.75 + 0.06 * Math.sin(this.time * 2.3) + 0.03 * Math.sin(this.time * 5.1));
    const L = this.body.lantern;
    L.uniforms.uGlow.value = g * (0.9 + 1.5 * night);
    (L.halo.material as THREE.SpriteMaterial).opacity = clamp01(g * (0.16 + 0.5 * night));
    L.halo.scale.setScalar(0.3 + 0.28 * g);
    L.light.intensity = g * (0.12 + 1.5 * night);
    const spots = g * (0.2 + 1.1 * night);
    this.body.skinUniforms.uGlow.value = spots;
    this.body.furUniforms.uGlow.value = spots;
  }

  private updateShadows(p: Pose): void {
    const k = this.k;
    const dayDim = 1 - 0.45 * k.world.night;
    const low = clamp01(1 + (p.hipsY + p.chestY) * 3);
    const hx = this.worldPos.x - Math.sin(this.yaw) * 0.03, hz = this.worldPos.z - Math.cos(this.yaw) * 0.03;
    const gy = heightAt(hx, hz);
    this.shadowBody.position.set(hx, gy + 0.006, hz);
    this.shadowBody.rotation.z = this.yaw;
    this.shadowBody.scale.set(0.8, 1.15, 1);
    (this.shadowBody.material as THREE.MeshBasicMaterial).opacity = (0.34 + 0.2 * (1 - low)) * dayDim * (1 - clamp01(this.leapY * 3));
    const n = normalAt(hx, hz);
    this.shadowBody.rotation.x = -Math.PI / 2 + n.z * 0.9;
    this.shadowBody.rotation.y = -n.x * 0.9;
    for (let i = 0; i < 4; i++) {
      const f = this.feet[i], m = this.shadowFeet[i];
      const g = heightAt(f.pos.x, f.pos.z);
      m.position.set(f.pos.x, g + 0.007, f.pos.z);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.55 * dayDim * clamp01(1 - f.air * 14) * (k.posture === 'stand' ? 1 : 0.4);
    }
  }

  dispose(): void {
    this.shadowBody.removeFromParent();
    for (const m of this.shadowFeet) m.removeFromParent();
  }
}

const _b1 = new V(), _b2 = new V(), _b3 = new V();
const _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4();
const _cq = new Q(), _cq2 = new Q(), _cq3 = new Q(), _cq4 = new Q();
const _co = new V();
const _ct = Array.from({ length: 12 }, () => new V());
void Z; void easeOutCubic;

let _blob: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (_blob) return _blob;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
      const a = Math.pow(clamp01(1 - d), 1.7);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  _blob = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  _blob.needsUpdate = true;
  return _blob;
}
