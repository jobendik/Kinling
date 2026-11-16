/**
 * World objects as Yuka entities: occluding obstacles, physical toys,
 * berries, the player-driven wisp lure, and curios. Toy physics is a small
 * purpose-built integrator (sphere on a heightfield) rather than a physics
 * engine: it is all the glade needs and stays deterministic.
 */
import { GameEntity, MovingEntity, Ray, Vector3 } from 'yuka';
import { clamp, damp } from '../core/math';
import { gladeEdge, heightAt, normalAt, OBSTACLES, POND, WATER_Y, type Obstacle } from './terrain';
import type { CurioKind, ToyKind } from './types';
import type { World } from './world';

const EYE_HEIGHT = 0.42;

/** A rock, log or trunk. Blocks sight when taller than a Kinling's eye line. */
export class ObstacleEntity extends GameEntity {
  constructor(readonly def: Obstacle) {
    super();
    this.name = def.id;
    this.position.set(def.x, heightAt(def.x, def.z), def.z);
    this.boundingRadius = def.r;
    this.canActivateTrigger = false;
  }

  /** Ray vs. upright cylinder (a circle on the ground plane). */
  override lineOfSightTest(ray: Ray, intersectionPoint: Vector3): Vector3 | null {
    if (this.def.h < EYE_HEIGHT) return null;
    const ox = ray.origin.x - this.def.x, oz = ray.origin.z - this.def.z;
    const dx = ray.direction.x, dz = ray.direction.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-8) return null;
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - this.def.r * this.def.r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) return null;
    intersectionPoint.copy(ray.direction).multiplyScalar(t).add(ray.origin);
    return intersectionPoint;
  }
}

const TOY_SPEC: Record<ToyKind, { radius: number; restitution: number; friction: number; gravity: number }> = {
  ball: { radius: 0.085, restitution: 0.5, friction: 0.55, gravity: 6.8 },
  rattle: { radius: 0.075, restitution: 0.28, friction: 1.7, gravity: 7.5 },
};

export class Toy extends MovingEntity {
  readonly radius: number;
  state: 'free' | 'carried' = 'free';
  resting = true;
  inWater = false;
  /** Sim time of the last player throw or nudge; drives chase interest. */
  thrownAt = -1e9;
  /** Sim time it last moved noticeably (by anyone). */
  movedAt = -1e9;
  /** Accumulated roll, for rendering. */
  roll = new Vector3();
  private restTimer = 0;

  constructor(readonly kind: ToyKind, private world: World, x: number, z: number) {
    super();
    this.name = kind;
    this.radius = TOY_SPEC[kind].radius;
    this.boundingRadius = this.radius;
    this.maxSpeed = 12;
    this.updateOrientation = false;
    this.canActivateTrigger = true;
    this.position.set(x, heightAt(x, z) + this.radius, z);
  }

  impulse(vx: number, vy: number, vz: number, byPlayer: boolean): void {
    if (this.state !== 'free') return;
    this.velocity.set(vx, vy, vz);
    this.resting = false;
    this.restTimer = 0;
    this.movedAt = this.world.time;
    if (byPlayer) this.thrownAt = this.world.time;
  }

  override update(dt: number): this {
    if (this.state === 'carried') return this;
    if (this.resting) return this;
    const spec = TOY_SPEC[this.kind];
    const p = this.position, v = this.velocity;
    v.y -= spec.gravity * dt;
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;

    // water: it floats, slows, and drifts back toward the bank
    const ground = heightAt(p.x, p.z);
    const wasInWater = this.inWater;
    this.inWater = ground < WATER_Y - 0.03 && p.y - this.radius < WATER_Y + 0.02;
    if (this.inWater) {
      if (!wasInWater) {
        const s = Math.hypot(v.x, v.y, v.z);
        this.world.events.emit('toyImpact', { kind: this.kind, speed: s, x: p.x, z: p.z, surface: 'water' });
        this.world.events.emit('ripple', { x: p.x, z: p.z, strength: clamp(0.4 + s * 0.3, 0.3, 1.2) });
        this.world.emitSound({ kind: 'splash', x: p.x, z: p.z, loud: clamp(0.25 + s * 0.1, 0.2, 0.6), sourceId: this.name });
      }
      const float = WATER_Y + this.radius * 0.35;
      if (p.y < float) { p.y = float; v.y = Math.max(v.y, 0) * 0.3; }
      const k = Math.exp(-2.2 * dt);
      v.x *= k; v.z *= k;
      const dx = p.x - POND.x, dz = p.z - POND.z;
      const d = Math.hypot(dx, dz) || 1;
      v.x += (dx / d) * 0.55 * dt;
      v.z += (dz / d) * 0.55 * dt;
    } else if (p.y - this.radius <= ground) {
      const n = normalAt(p.x, p.z);
      p.y = ground + this.radius;
      const vn = v.x * n.x + v.y * n.y + v.z * n.z;
      if (vn < 0) {
        const bounce = -vn > 0.5 ? spec.restitution : 0;
        v.x -= (1 + bounce) * vn * n.x;
        v.y -= (1 + bounce) * vn * n.y;
        v.z -= (1 + bounce) * vn * n.z;
        if (-vn > 0.7) {
          this.world.events.emit('toyImpact', { kind: this.kind, speed: -vn, x: p.x, z: p.z, surface: 'ground' });
          this.world.emitSound({ kind: this.kind === 'rattle' ? 'rattle' : 'bounce', x: p.x, z: p.z, loud: clamp(-vn * 0.12, 0.08, 0.5), sourceId: this.name });
        }
      }
      // rolling: slope pulls, grass drags
      v.x += n.x * spec.gravity * 0.5 * dt;
      v.z += n.z * spec.gravity * 0.5 * dt;
      const k = Math.exp(-spec.friction * dt);
      v.x *= k; v.z *= k;
    }

    // obstacles
    for (const o of OBSTACLES) {
      if (p.y - this.radius > heightAt(o.x, o.z) + o.h) continue;
      const dx = p.x - o.x, dz = p.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + this.radius;
      if (d < min && d > 1e-5) {
        const nx = dx / d, nz = dz / d;
        p.x = o.x + nx * min; p.z = o.z + nz * min;
        const vn = v.x * nx + v.z * nz;
        if (vn < 0) {
          v.x -= 1.5 * vn * nx; v.z -= 1.5 * vn * nz;
          if (-vn > 0.6) {
            this.world.events.emit('toyImpact', { kind: this.kind, speed: -vn, x: p.x, z: p.z, surface: 'rock' });
            this.world.emitSound({ kind: this.kind === 'rattle' ? 'rattle' : 'bounce', x: p.x, z: p.z, loud: clamp(-vn * 0.14, 0.1, 0.55), sourceId: this.name });
          }
        }
      }
    }
    // the bank returns it to the glade
    const r = Math.hypot(p.x, p.z);
    const edge = gladeEdge(p.x, p.z) - 0.25;
    if (r > edge) {
      const nx = -p.x / r, nz = -p.z / r;
      const vn = v.x * nx + v.z * nz;
      if (vn < 0) { v.x -= 1.4 * vn * nx; v.z -= 1.4 * vn * nz; }
      v.x += nx * 2.5 * dt; v.z += nz * 2.5 * dt;
    }

    const hs = Math.hypot(v.x, v.z);
    if (hs > 0.02) {
      this.roll.x += (v.z / this.radius) * dt;
      this.roll.z -= (v.x / this.radius) * dt;
      this.movedAt = hs > 0.25 ? this.world.time : this.movedAt;
    }
    const grounded = this.inWater || p.y - this.radius <= heightAt(p.x, p.z) + 0.004;
    if (grounded && hs < 0.05 && Math.abs(v.y) < 0.25) {
      this.restTimer += dt;
      if (this.restTimer > 0.35) { this.resting = true; v.set(0, 0, 0); }
    } else this.restTimer = 0;
    return this;
  }
}

export class Berry extends GameEntity {
  eaten = false;
  private vy = 0;
  private settled = false;
  constructor(private world: World, x: number, z: number, readonly fromPlayer: boolean, readonly bornAt: number, dropHeight = 1.1) {
    super();
    this.name = 'berry';
    this.boundingRadius = 0.03;
    this.position.set(x, heightAt(x, z) + dropHeight, z);
    if (dropHeight <= 0.01) this.settled = true;
  }
  override update(dt: number): this {
    if (this.settled) return this;
    this.vy -= 7 * dt;
    this.position.y += this.vy * dt;
    const g = heightAt(this.position.x, this.position.z) + 0.028;
    if (this.position.y <= g) {
      this.position.y = g;
      if (this.vy < -1.2) {
        this.world.events.emit('toyImpact', { kind: 'berry', speed: -this.vy, x: this.position.x, z: this.position.z, surface: 'ground' });
        this.world.emitSound({ kind: 'plop', x: this.position.x, z: this.position.z, loud: 0.18, sourceId: 'berry' });
        this.vy = -this.vy * 0.25;
      } else { this.vy = 0; this.settled = true; }
    }
    return this;
  }
}

/** The lure the player leads around: a drifting mote of light. */
export class Wisp extends MovingEntity {
  on = false;
  target = new Vector3();
  /** >0 while it darts out of reach after being caught. */
  escape = 0;
  hover = 0.24;
  constructor() {
    super();
    this.name = 'wisp';
    this.boundingRadius = 0.05;
    this.maxSpeed = 9;
    this.updateOrientation = false;
    this.active = true;
  }
  override update(dt: number): this {
    if (!this.on) return this;
    this.escape = Math.max(0, this.escape - dt);
    const targetHover = this.escape > 0 ? 0.95 : 0.24;
    this.hover = damp(this.hover, targetHover, 7, dt);
    const tx = this.target.x, tz = this.target.z;
    const px = this.position.x, pz = this.position.z;
    const nx = damp(px, tx, 9, dt), nz = damp(pz, tz, 9, dt);
    this.velocity.set((nx - px) / dt, 0, (nz - pz) / dt);
    this.position.set(nx, heightAt(nx, nz) + this.hover, nz);
    return this;
  }
}

/** Something new the player sets down: it hums, spins or chimes now and then. */
export class Curio extends GameEntity {
  nextChime: number;
  constructor(private world: World, readonly kind: CurioKind, x: number, z: number) {
    super();
    this.name = `curio:${kind}`;
    this.boundingRadius = 0.16;
    this.position.set(x, heightAt(x, z), z);
    this.nextChime = world.time + 5 + world.rng.range(0, 3);
  }
  override update(): this {
    if (this.world.time >= this.nextChime) {
      this.nextChime = this.world.time + 9 + this.world.rng.range(0, 7);
      this.world.events.emit('curio', { type: 'chime', kind: this.kind, x: this.position.x, z: this.position.z });
      this.world.emitSound({ kind: 'chime', x: this.position.x, z: this.position.z, loud: this.kind === 'shell' ? 0.62 : 0.5, sourceId: this.name });
    }
    return this;
  }
}
