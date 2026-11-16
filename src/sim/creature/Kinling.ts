/**
 * The agent. A Yuka Vehicle that is the single authoritative owner of the
 * creature's position, heading and velocity. Steering behaviours propose a
 * desired velocity; `update` turns that into quadruped-like motion (it turns
 * before it runs, accelerates and brakes), then resolves collisions against
 * the same walkability rules the navigation graph was built from.
 *
 * Responsibilities, in update order:
 *   senses → body state machine → brain (Think + goals) → movement → needs/affect
 * Animation and audio only ever read this state.
 */
import {
  ArriveBehavior, FleeBehavior, FollowPathBehavior, GameEntity, ObstacleAvoidanceBehavior, OnPathBehavior, Path,
  PursuitBehavior, StateMachine, Telegram, Vector3, Vehicle, WanderBehavior,
} from 'yuka';
import { angleDelta, approach, clamp, clamp01, damp, lerp, smoothstep } from '../../core/math';
import { Rng } from '../../core/rng';
import { Affect } from '../affect';
import type { Identity, TouchRegion, Traits } from '../identity';
import { Learning } from '../learning';
import { LongTermMemory } from '../memory';
import { BODY_RADIUS } from '../nav';
import { Needs, RUN_SPEED } from '../needs';
import { heightAt, resolveCollision } from '../terrain';
import type { ActionKind, BodyMode, MoveStyle, Posture, Vec2, VocalKind } from '../types';
import type { Toy } from '../entities';
import type { World } from '../world';
import { createBodyMachine } from './bodyStates';
import { Brain } from './brain';
import { Senses } from './senses';

export const STYLE_SPEED: Record<MoveStyle, number> = {
  amble: 0.4, walk: 0.58, trot: 1.2, run: RUN_SPEED, sneak: 0.3, cautious: 0.36, tired: 0.33,
};

export interface ActionSpec {
  duration: number;
  contacts: number[];
  /** Must the creature be on its feet to do this? */
  standing: boolean;
}

export const ACTIONS: Record<ActionKind, ActionSpec> = {
  eat: { duration: 2.6, contacts: [0.85, 1.7], standing: true },
  drink: { duration: 4.4, contacts: [0.9, 1.5, 2.1, 2.7, 3.3], standing: true },
  sniff: { duration: 1.7, contacts: [0.9], standing: true },
  pounce: { duration: 0.8, contacts: [0.46], standing: true },
  pickup: { duration: 0.75, contacts: [0.42], standing: true },
  drop: { duration: 0.6, contacts: [0.3], standing: true },
  bat: { duration: 0.75, contacts: [0.36], standing: true },
  gnaw: { duration: 3.6, contacts: [0.9, 1.8, 2.7], standing: false },
  playBow: { duration: 1.6, contacts: [0.55], standing: true },
  stretch: { duration: 2.7, contacts: [], standing: true },
  shake: { duration: 1.3, contacts: [], standing: true },
  groom: { duration: 3.3, contacts: [], standing: false },
  yawn: { duration: 2.1, contacts: [0.6], standing: false },
  headTilt: { duration: 1.6, contacts: [], standing: false },
  knead: { duration: 3.4, contacts: [0.6, 1.2, 1.8, 2.4], standing: true },
  chirp: { duration: 0.9, contacts: [0.2], standing: false },
  greet: { duration: 2.1, contacts: [0.3, 1.0], standing: true },
  wiggle: { duration: 0.95, contacts: [], standing: true },
  pawAt: { duration: 1.4, contacts: [0.6], standing: false },
  lookAway: { duration: 1.9, contacts: [], standing: false },
  perk: { duration: 0.7, contacts: [], standing: false },
  nuzzle: { duration: 1.6, contacts: [], standing: false },
  spin: { duration: 1.5, contacts: [], standing: true },
};

export interface ActionState {
  kind: ActionKind;
  t: number;
  duration: number;
  fired: number;
  spec: ActionSpec;
  target: { x: number; y: number; z: number } | null;
  onContact?: (index: number) => void;
  onEnd?: (completed: boolean) => void;
  returnTo: BodyMode;
  /** Incremented per performance so presentation can detect restarts. */
  serial: number;
}

export interface Travel {
  kind: 'none' | 'path' | 'pursue' | 'wander' | 'flee';
  dest: Vec2 | null;
  arrive: number;
  path: Vec2[] | null;
}

export class Kinling extends Vehicle {
  readonly needs = new Needs();
  readonly affect = new Affect();
  readonly learn: Learning;
  readonly ltm = new LongTermMemory();
  readonly senses: Senses;
  readonly brain: Brain;
  readonly body: StateMachine<Kinling>;
  readonly headEntity = new GameEntity();
  readonly rng: Rng;
  traits: Traits;

  dt = 0;
  heading = 0;
  speed = 0;
  yawRate = 0;
  style: MoveStyle = 'walk';
  mode: BodyMode = 'FREE';
  posture: Posture = 'stand';
  /** Seconds in the current posture. */
  postureT = 10;
  /** Seconds left before it is back on its feet. */
  riseT = 0;
  action: ActionState | null = null;
  private actionSerial = 0;
  travel: Travel = { kind: 'none', dest: null, arrive: 0.25, path: null };
  faceTarget: Vec2 | null = null;
  gaze = { x: 0, y: 0.4, z: 0, active: false, until: 0, priority: 0 };
  headYaw = 0;
  carrying: Toy | null = null;
  inNest = false;
  inShallows = false;
  sleepDepth = 0;
  /** Ears-up alertness that decays in about a second. */
  alert = 0;
  startle = { strength: 0, x: 0, z: 0, phase: 'none' as 'none' | 'flinch' | 'watch' | 'recover', t: 0, kind: '' };
  touch = { region: 'head' as TouchRegion, x: 0, y: 0, z: 0, at: -1e9, liked: 0, strokes: 0, boutStart: -1e9, placeNoted: false };
  recoil = { x: 0, z: 0 };
  playing = false;
  stuckT = 0;
  lastVocalAt = -1e9;
  /** Lifetime counters, a small part of the save. */
  stats = { distance: 0, naps: 0, berries: 0, catches: 0, pets: 0 };

  private readonly arrive = new ArriveBehavior(new Vector3(), 2.2, 0.03);
  private readonly follow = new FollowPathBehavior(new Path(), 0.32);
  private readonly onPath = new OnPathBehavior(this.follow.path, 0.2, 0.6);
  private readonly pursuit = new PursuitBehavior(null as never, 0.8);
  private readonly wander: WanderBehavior;
  private readonly flee = new FleeBehavior(new Vector3(), 4);
  private readonly avoid: ObstacleAvoidanceBehavior;
  private readonly force = new Vector3();
  private progressAnchor = { x: 0, z: 0, t: 0 };
  private traitRefresh = 0;

  constructor(readonly world: World, readonly identity: Identity) {
    super();
    this.name = 'kinling';
    this.rng = new Rng(identity.seed).fork('mind');
    this.learn = new Learning(identity);
    this.traits = this.learn.traits();
    this.boundingRadius = BODY_RADIUS;
    this.maxSpeed = STYLE_SPEED.walk;
    this.maxForce = 50;
    this.updateOrientation = false;

    this.headEntity.position.set(0, 0.42, 0.3);
    this.headEntity.canActivateTrigger = false;
    this.add(this.headEntity);

    // seeded wander: Yuka's WanderBehavior with deterministic jitter
    const wrng = this.rng.fork('wander');
    this.wander = new (class extends WanderBehavior {
      private local = new Vector3(0, 0, 1);
      override calculate(vehicle: Vehicle, force: Vector3, delta: number): Vector3 {
        const j = this.jitter * delta;
        this.local.x += wrng.range(-1, 1) * j;
        this.local.z += wrng.range(-1, 1) * j;
        this.local.normalize().multiplyScalar(this.radius);
        const target = new Vector3(this.local.x, 0, this.local.z + this.distance).applyMatrix4(vehicle.worldMatrix);
        return force.subVectors(target, vehicle.position);
      }
    })(0.7, 1.4, 2.2);
    this.avoid = new ObstacleAvoidanceBehavior(world.obstacles);
    this.avoid.dBoxMinLength = 0.9;
    this.avoid.weight = 1.6;
    for (const b of [this.arrive, this.follow, this.onPath, this.pursuit, this.wander, this.flee, this.avoid]) {
      b.active = false;
      this.steering.add(b);
    }
    this.onPath.weight = 0.6;

    this.senses = new Senses(this);
    this.body = createBodyMachine(this);
    this.brain = new Brain(this);
    this.learn.onChange = (e) => world.events.emit('learn', e);
    this.ltm.onRecord = (e) => world.events.emit('memory', { text: `${e.kind}${e.subject ? ' · ' + e.subject : ''}${e.count > 1 ? ' ×' + e.count : ''} — ${e.note}` });
  }

  place(x: number, z: number, heading: number): void {
    this.position.set(x, heightAt(x, z), z);
    this.heading = heading;
    this.rotation.fromEuler(0, heading, 0);
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.progressAnchor = { x, z, t: this.world.time };
  }

  get now(): number {
    return this.world.time;
  }
  get canMove(): boolean {
    return this.mode === 'FREE' && this.riseT <= 0;
  }
  get asleep(): boolean {
    return this.mode === 'ASLEEP';
  }
  get mouth(): { x: number; y: number; z: number } {
    return {
      x: this.position.x + Math.sin(this.heading) * 0.36,
      y: this.position.y + (this.posture === 'stand' ? 0.3 : 0.2),
      z: this.position.z + Math.cos(this.heading) * 0.36,
    };
  }
  distanceTo(x: number, z: number): number {
    return Math.hypot(this.position.x - x, this.position.z - z);
  }

  // ── messages: Yuka telegrams routed through the body state machine ──
  override handleMessage(telegram: Telegram): boolean {
    return this.body.handleMessage(telegram);
  }

  // ── travel ─────────────────────────────────────────────────────
  private setSteering(kind: Travel['kind']): void {
    this.arrive.active = false;
    this.follow.active = kind === 'path';
    this.onPath.active = kind === 'path' && (this.travel.path?.length ?? 0) > 2;
    this.pursuit.active = kind === 'pursue';
    this.wander.active = kind === 'wander';
    this.flee.active = kind === 'flee';
    this.avoid.active = kind !== 'none';
    this.travel.kind = kind;
    this.stuckT = 0;
    this.progressAnchor = { x: this.position.x, z: this.position.z, t: this.now };
  }

  /** Plan and start walking to a point. False when it cannot be reached. */
  travelTo(x: number, z: number, style: MoveStyle, arrive = 0.25): boolean {
    const path = this.world.nav.findPath({ x: this.position.x, z: this.position.z }, { x, z });
    if (!path) return false;
    this.follow.path.clear();
    for (const p of path) this.follow.path.add(new Vector3(p.x, 0, p.z));
    const end = path[path.length - 1];
    this.travel.dest = { x: end.x, z: end.z };
    this.travel.arrive = arrive;
    this.travel.path = path;
    this.style = style;
    this.faceTarget = null;
    this.setSteering('path');
    return true;
  }

  travelPursue(target: Vehicle | GameEntity, style: MoveStyle, arrive = 0.3): void {
    this.pursuit.evader = target as Vehicle;
    this.travel.dest = { x: target.position.x, z: target.position.z };
    this.travel.arrive = arrive;
    this.travel.path = null;
    this.style = style;
    this.faceTarget = null;
    this.setSteering('pursue');
  }

  travelWander(style: MoveStyle): void {
    this.travel.dest = null;
    this.travel.path = null;
    this.style = style;
    this.faceTarget = null;
    this.setSteering('wander');
  }

  travelFlee(x: number, z: number, style: MoveStyle): void {
    this.flee.target.set(x, 0, z);
    this.travel.dest = null;
    this.travel.path = null;
    this.style = style;
    this.setSteering('flee');
  }

  stopTravel(): void {
    this.travel.dest = null;
    this.travel.path = null;
    this.setSteering('none');
  }

  arrived(): boolean {
    const d = this.travel.dest;
    return !!d && this.distanceTo(d.x, d.z) <= this.travel.arrive;
  }

  face(x: number, z: number): void {
    this.faceTarget = { x, z };
  }
  facing(x: number, z: number, tolerance = 0.3): boolean {
    return Math.abs(angleDelta(this.heading, Math.atan2(x - this.position.x, z - this.position.z))) < tolerance;
  }

  // ── attention ──────────────────────────────────────────────────
  /** Turn eyes and head toward a point. Higher priority wins until it expires. */
  look(x: number, y: number, z: number, hold = 1.5, priority = 1): void {
    if (this.gaze.active && this.gaze.until > this.now && priority < this.gaze.priority) return;
    this.gaze.x = x; this.gaze.y = y; this.gaze.z = z;
    this.gaze.active = true;
    this.gaze.until = this.now + hold;
    this.gaze.priority = priority;
  }
  lookAtPlayer(hold = 2, priority = 1): void {
    const p = this.world.playerSpot;
    // the player is "up there": beyond the spot, toward the camera
    this.look(p.x * 1.25, 1.5, p.z * 1.25 + 0.8, hold, priority);
  }

  // ── posture and actions (requests; the body machine sequences them) ──
  settle(posture: 'sit' | 'lie'): void {
    if (this.mode === 'INTERACT' || this.mode === 'STARTLED' || this.mode === 'ASLEEP') return;
    if (this.posture !== posture) { this.posture = posture; this.postureT = 0; }
    this.riseT = 0;
    if (this.mode !== 'SETTLED') this.body.changeTo('SETTLED');
  }
  get settled(): boolean {
    return this.mode === 'SETTLED' && this.postureT > (this.posture === 'lie' ? 0.9 : 0.5);
  }
  rise(): void {
    if (this.mode === 'SETTLED' || this.mode === 'ASLEEP') {
      this.riseT = this.posture === 'sit' ? 0.45 : this.posture === 'lie' ? 0.85 : 1.7;
      this.posture = 'stand';
      this.postureT = 0;
      this.body.changeTo('FREE');
    }
  }
  fallAsleep(): void {
    if (this.mode === 'SETTLED' || this.mode === 'FREE') this.body.changeTo('ASLEEP');
  }

  perform(kind: ActionKind, opts: { target?: { x: number; y: number; z: number } | null; onContact?: (i: number) => void; onEnd?: (done: boolean) => void } = {}): boolean {
    const spec = ACTIONS[kind];
    if (this.mode === 'STARTLED' || this.mode === 'ASLEEP' || this.mode === 'INTERACT') return false;
    if (spec.standing && (this.mode !== 'FREE' || this.riseT > 0)) return false;
    this.action = {
      kind, t: 0, duration: spec.duration, fired: 0, spec,
      target: opts.target ?? null, onContact: opts.onContact, onEnd: opts.onEnd,
      returnTo: this.mode, serial: ++this.actionSerial,
    };
    this.body.changeTo('INTERACT');
    return true;
  }
  cancelAction(): void {
    if (this.mode === 'INTERACT') this.body.changeTo(this.action?.returnTo === 'SETTLED' ? 'SETTLED' : 'FREE');
  }

  // ── carrying ───────────────────────────────────────────────────
  take(toy: Toy): void {
    this.carrying = toy;
    toy.state = 'carried';
    toy.resting = true;
    toy.velocity.set(0, 0, 0);
    this.world.events.emit('pickup', { toy: toy.kind });
  }
  /** Let go of whatever is carried, restoring it to free physics. Always safe to call. */
  release(tossForward = 0.5): void {
    const toy = this.carrying;
    if (!toy) return;
    this.carrying = null;
    toy.state = 'free';
    const m = this.mouth;
    toy.position.set(m.x, Math.max(m.y - 0.05, heightAt(m.x, m.z) + toy.radius), m.z);
    toy.impulse(Math.sin(this.heading) * tossForward + this.velocity.x * 0.5, 0.4, Math.cos(this.heading) * tossForward + this.velocity.z * 0.5, false);
    this.world.events.emit('dropToy', { toy: toy.kind });
  }

  vocal(kind: VocalKind, intensity = 0.6, minGap = 0.6): void {
    if (this.now - this.lastVocalAt < minGap) return;
    this.lastVocalAt = this.now;
    this.world.events.emit('vocal', { kind, intensity });
  }

  /** How luminous the tail lantern is: comfort and attention made visible. */
  get glow(): number {
    if (this.asleep) return 0.16 + 0.06 * Math.sin(this.now * 1.1);
    const a = this.affect;
    return clamp01(0.42 + 0.3 * a.valence + 0.25 * a.interest + 0.15 * a.arousal - 0.3 * a.wariness + 0.35 * this.alert);
  }

  // ── the tick ───────────────────────────────────────────────────
  override update(dt: number): this {
    this.dt = dt;
    this.postureT += dt;
    if (this.riseT > 0) this.riseT = Math.max(0, this.riseT - dt);
    this.alert = damp(this.alert, 0, 1.2, dt);
    if ((this.traitRefresh -= dt) <= 0) { this.traits = this.learn.traits(); this.traitRefresh = 2; }

    this.senses.update(dt);
    this.body.update();
    this.brain.update(dt);
    this.move(dt);
    this.updateGaze(dt);

    const exertion = clamp01(this.speed / RUN_SPEED);
    this.needs.update(dt, {
      exertion, asleep: this.asleep, resting: this.mode === 'SETTLED' && this.posture === 'lie',
      playing: this.playing, inNest: this.inNest, night: this.world.night, traits: this.traits,
    });
    this.affect.update(dt, this.needs.comfort(), this.needs.values.energy, this.world.night, this.traits);
    this.ltm.decay(dt);
    this.learn.tread(this.position.x, this.position.z, dt);
    this.learn.fadeExplored(dt);

    if (this.carrying) {
      const m = this.mouth;
      this.carrying.position.set(m.x, m.y, m.z);
    }
    return this;
  }

  private move(dt: number): void {
    const p = this.position;
    let desiredSpeed = 0;
    let targetYaw = this.heading;
    const tired = smoothstep(0.3, 0.05, this.needs.values.energy);
    const top = STYLE_SPEED[this.style] * (1 - 0.3 * tired);
    this.maxSpeed = top;

    const a = this.action;
    const leaping = a?.kind === 'pounce' && a.t > 0.16 && a.t < 0.46;
    if (leaping) {
      desiredSpeed = 2.5;
    } else if (this.canMove && this.travel.kind !== 'none') {
      if (this.travel.kind === 'pursue' && this.pursuit.evader) {
        const e = this.pursuit.evader.position;
        this.travel.dest = { x: e.x, z: e.z };
      }
      this.force.set(0, 0, 0);
      this.steering.calculate(dt, this.force);
      const dx = this.velocity.x + this.force.x, dz = this.velocity.z + this.force.z;
      const d = Math.hypot(dx, dz);
      desiredSpeed = Math.min(d, top);
      if (d > 0.02) targetYaw = Math.atan2(dx, dz);
      if (this.travel.dest && this.travel.kind !== 'wander') {
        const dist = this.distanceTo(this.travel.dest.x, this.travel.dest.z);
        if (dist <= this.travel.arrive) desiredSpeed = 0;
        else if (this.travel.kind === 'path' || this.style !== 'run') desiredSpeed = Math.min(desiredSpeed, 0.12 + (dist - this.travel.arrive) * 2.4);
      }
    } else if (this.faceTarget && this.mode === 'FREE' && this.riseT <= 0) {
      targetYaw = Math.atan2(this.faceTarget.x - p.x, this.faceTarget.z - p.z);
      if (Math.abs(angleDelta(this.heading, targetYaw)) < 0.06) this.faceTarget = null;
    }

    // turn first, then go: a body with mass and a turning circle
    const delta = angleDelta(this.heading, targetYaw);
    const maxTurn = lerp(4.4, 2.3, clamp01(this.speed / RUN_SPEED)) * (1 - 0.3 * tired);
    const wantRate = leaping ? 0 : clamp(delta * 7, -maxTurn, maxTurn);
    this.yawRate = damp(this.yawRate, wantRate, 12, dt);
    this.heading += this.yawRate * dt;
    const align = Math.cos(delta);
    const target = desiredSpeed * (leaping ? 1 : smoothstep(0.15, 0.85, align));
    const accel = target > this.speed ? (leaping ? 22 : 2.6 + 2.5 * this.affect.arousal) : 5.5;
    this.speed = approach(this.speed, target, accel * dt);

    const sx = Math.sin(this.heading), cz = Math.cos(this.heading);
    this.velocity.set(sx * this.speed, 0, cz * this.speed);
    // recoil (startle hop) is an extra, decaying displacement
    p.x += (this.velocity.x + this.recoil.x) * dt;
    p.z += (this.velocity.z + this.recoil.z) * dt;
    const rk = Math.exp(-7 * dt);
    this.recoil.x *= rk; this.recoil.z *= rk;
    if (resolveCollision(p, BODY_RADIUS)) this.speed *= Math.exp(-3 * dt);
    p.y = heightAt(p.x, p.z);
    this.rotation.fromEuler(0, this.heading, 0);
    this.stats.distance += this.speed * dt;

    // stuck detection for the goals to act on
    if (this.travel.kind === 'path' || this.travel.kind === 'pursue') {
      if (this.now - this.progressAnchor.t > 1.5) {
        const moved = Math.hypot(p.x - this.progressAnchor.x, p.z - this.progressAnchor.z);
        if (moved < 0.08 && this.canMove && !this.arrived()) this.stuckT += this.now - this.progressAnchor.t;
        else this.stuckT = 0;
        this.progressAnchor = { x: p.x, z: p.z, t: this.now };
      }
    }
  }

  private updateGaze(dt: number): void {
    if (this.gaze.active && this.now > this.gaze.until) { this.gaze.active = false; this.gaze.priority = 0; }
    let want = 0;
    if (this.gaze.active && !this.asleep) {
      const yaw = Math.atan2(this.gaze.x - this.position.x, this.gaze.z - this.position.z);
      want = clamp(angleDelta(this.heading, yaw), -1.35, 1.35);
    }
    this.headYaw = approach(this.headYaw, want, 5.5 * dt);
    this.headEntity.rotation.fromEuler(0, this.headYaw, 0);
  }
}
