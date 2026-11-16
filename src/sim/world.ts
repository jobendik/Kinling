/**
 * The simulated sanctuary. Owns the Yuka EntityManager, the creature, the
 * objects in the glade and the passage of time. It has no knowledge of
 * rendering: presentation layers read state and subscribe to `events`.
 */
import { EntityManager, GameEntity, SphericalTriggerRegion, Trigger } from 'yuka';
import { clamp, smoothstep } from '../core/math';
import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { Kinling } from './creature/Kinling';
import { Berry, Curio, ObstacleEntity, Toy, Wisp } from './entities';
import type { Identity, TouchRegion } from './identity';
import { Nav } from './nav';
import { BUSH, DEFAULT_PLAYER_SPOT, heightAt, isWalkable, nearestWalkable, NEST, OBSTACLES, POND, SPAWN, waterDepthAt } from './terrain';
import { MSG, type CueKind, type CurioKind, type SimEvents, type SoundEvent, type ToyKind, type Vec2 } from './types';

export const DAY_LENGTH_S = 24 * 60;
export const MAX_PLAYER_BERRIES = 5;
export const BUSH_CAPACITY = 3;
const BUSH_REGROW_S = 110;

let sharedNav: Nav | null = null;

/** Sun elevation proxy in [-1,1] for a time of day in [0,1) (0.25 sunrise, 0.5 noon). */
export function sunHeight(dayTime: number): number {
  return Math.sin((dayTime - 0.25) * Math.PI * 2);
}
export function nightFactor(dayTime: number): number {
  return smoothstep(0.12, -0.22, sunHeight(dayTime));
}

/** Wet paws at the pond's edge: ripples and a soft splash while wading. */
class ShoreTrigger extends Trigger {
  private last = -1;
  constructor(private world: World) {
    super(new SphericalTriggerRegion(POND.r + 0.5));
    this.position.set(POND.x, 0, POND.z);
  }
  override execute(entity: GameEntity): this {
    if (!(entity instanceof Kinling)) return this;
    const depth = waterDepthAt(entity.position.x, entity.position.z);
    entity.inShallows = depth > 0.005;
    if (entity.inShallows && entity.speed > 0.15 && this.world.time - this.last > 0.32) {
      this.last = this.world.time;
      this.world.events.emit('ripple', { x: entity.position.x, z: entity.position.z, strength: clamp(entity.speed * 0.5, 0.2, 0.8) });
      this.world.events.emit('sound', { kind: 'splash', x: entity.position.x, z: entity.position.z, loud: 0.12 });
    }
    return this;
  }
}

/** The nest is home: being in it restores security faster. */
class NestTrigger extends Trigger {
  constructor() {
    super(new SphericalTriggerRegion(NEST.r + 0.15));
    this.position.set(NEST.x, 0, NEST.z);
  }
  override execute(entity: GameEntity): this {
    if (entity instanceof Kinling) entity.inNest = true;
    return this;
  }
}

/** Tall grass patches rustle and part as the creature or a toy passes through. */
class GrassTrigger extends Trigger {
  private last = -1;
  constructor(private world: World, x: number, z: number, r: number) {
    super(new SphericalTriggerRegion(r));
    this.position.set(x, 0, z);
  }
  override execute(entity: GameEntity): this {
    const moving = entity instanceof Kinling ? entity.speed : entity instanceof Toy && !entity.resting ? entity.velocity.length() : 0;
    if (moving > 0.3 && this.world.time - this.last > 0.45) {
      this.last = this.world.time;
      this.world.events.emit('rustle', { x: entity.position.x, z: entity.position.z, strength: clamp(moving * 0.4, 0.15, 1) });
    }
    return this;
  }
}

export const GRASS_PATCHES: ReadonlyArray<{ x: number; z: number; r: number }> = [
  { x: -2.4, z: -1.1, r: 1.1 },
  { x: 2.9, z: 4.4, r: 1.2 },
  { x: 5.0, z: -2.6, r: 1.0 },
  { x: -4.6, z: 5.0, r: 0.9 },
];

export class World {
  readonly events = new Emitter<SimEvents>();
  readonly manager = new EntityManager();
  readonly nav: Nav;
  readonly rng: Rng;
  readonly kinling: Kinling;
  readonly toys: Record<ToyKind, Toy>;
  readonly wisp = new Wisp();
  readonly obstacles: ObstacleEntity[] = [];
  readonly source = new GameEntity();
  berries: Berry[] = [];
  curio: Curio | null = null;
  bushStock = 2;
  private bushTimer = 0;

  /** Seconds this Kinling has lived (simulated, including credited absence). */
  time = 0;
  dayTime = 0.6;
  /** Where the creature believes the player is: a spot on the ground near the camera. */
  playerSpot: Vec2 = { x: DEFAULT_PLAYER_SPOT.x, z: DEFAULT_PLAYER_SPOT.z };
  /** Sim time of the last deliberate player action. */
  playerActiveAt = -1e9;
  /** Set when the player has just come back after time away. */
  reunionPending = 0;

  constructor(readonly identity: Identity, opts: { fresh?: boolean } = {}) {
    this.nav = sharedNav ?? (sharedNav = new Nav());
    this.rng = new Rng(identity.seed).fork('world');
    this.source.name = 'world';
    this.source.canActivateTrigger = false;
    this.manager.add(this.source);
    for (const o of OBSTACLES) {
      const e = new ObstacleEntity(o);
      this.obstacles.push(e);
      this.manager.add(e);
    }
    this.toys = {
      ball: new Toy('ball', this, 0.9, 0.4),
      rattle: new Toy('rattle', this, -1.7, -0.6),
    };
    this.manager.add(this.toys.ball);
    this.manager.add(this.toys.rattle);
    this.wisp.canActivateTrigger = false;
    this.manager.add(this.wisp);
    this.manager.add(new ShoreTrigger(this));
    this.manager.add(new NestTrigger());
    for (const g of GRASS_PATCHES) this.manager.add(new GrassTrigger(this, g.x, g.z, g.r));
    this.kinling = new Kinling(this, identity);
    this.kinling.place(SPAWN.x, SPAWN.z, 0.2);
    this.manager.add(this.kinling);
    void opts;
  }

  get night(): number {
    return nightFactor(this.dayTime);
  }

  step(dt: number): void {
    this.time += dt;
    // nights pass more quickly than days: a restrained cycle
    const rate = 1 + 1.5 * this.night;
    this.dayTime = (this.dayTime + (dt * rate) / DAY_LENGTH_S) % 1;
    this.kinling.inNest = false;
    this.kinling.inShallows = false;
    this.manager.update(dt);
    if (this.bushStock < BUSH_CAPACITY) {
      this.bushTimer += dt;
      if (this.bushTimer >= BUSH_REGROW_S) {
        this.bushTimer = 0;
        this.bushStock++;
        this.events.emit('berry', { type: 'regrow', x: BUSH.x, z: BUSH.z });
      }
    }
    if (this.berries.some((b) => b.eaten)) this.berries = this.berries.filter((b) => !b.eaten);
  }

  // ── sound propagation ──────────────────────────────────────────
  emitSound(e: SoundEvent): void {
    this.events.emit('sound', e);
    const k = this.kinling;
    const d = Math.hypot(e.x - k.position.x, e.z - k.position.z);
    const reach = 3 + e.loud * 14;
    if (d > reach) return;
    // a short, distance-dependent latency before the creature reacts
    this.manager.sendMessage(this.source, k, MSG.SOUND, 0.05 + d * 0.012, { ...e, distance: d });
  }

  // ── player actions ─────────────────────────────────────────────
  private touched(): void {
    this.playerActiveAt = this.time;
  }

  setPlayerSpot(x: number, z: number): void {
    const p = isWalkable(x, z, 0.25) ? { x, z } : nearestWalkable(x, z, 0.25);
    this.playerSpot.x = p.x;
    this.playerSpot.z = p.z;
  }

  /** Lob a free toy from where it lies toward a point on the ground. */
  tossToy(kind: ToyKind, tx: number, tz: number): boolean {
    const toy = this.toys[kind];
    if (toy.state !== 'free') return false;
    const dx = tx - toy.position.x, dz = tz - toy.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return false;
    const range = Math.min(d, 6.5);
    const g = kind === 'ball' ? 6.8 : 7.5;
    // 38° lob that lands a little short and rolls the rest of the way
    const v = Math.sqrt((range * 0.82 * g) / Math.sin(2 * 0.66));
    toy.impulse((dx / d) * v * Math.cos(0.66), v * Math.sin(0.66), (dz / d) * v * Math.cos(0.66), true);
    this.touched();
    return true;
  }

  /** Release a toy with an explicit velocity (drag-and-flick). */
  flingToy(kind: ToyKind, x: number, y: number, z: number, vx: number, vy: number, vz: number): boolean {
    const toy = this.toys[kind];
    if (toy.state !== 'free') return false;
    toy.position.set(x, Math.max(y, heightAt(x, z) + toy.radius), z);
    const s = Math.hypot(vx, vy, vz);
    const k = s > 7 ? 7 / s : 1;
    toy.impulse(vx * k, vy * k, vz * k, true);
    this.touched();
    return true;
  }

  dropBerry(x: number, z: number): boolean {
    if (this.berries.filter((b) => b.fromPlayer).length >= MAX_PLAYER_BERRIES) return false;
    const p = isWalkable(x, z, 0.05) ? { x, z } : nearestWalkable(x, z, 0.05);
    const b = new Berry(this, p.x, p.z, true, this.time);
    this.berries.push(b);
    this.manager.add(b);
    this.events.emit('berry', { type: 'drop', x: p.x, z: p.z });
    this.touched();
    return true;
  }

  removeBerry(b: Berry): void {
    b.eaten = true;
    this.manager.remove(b);
    this.kinling.senses.forget(b);
  }

  placeCurio(kind: CurioKind, x: number, z: number): void {
    this.removeCurio();
    const p = isWalkable(x, z, 0.3) ? { x, z } : nearestWalkable(x, z, 0.3);
    this.curio = new Curio(this, kind, p.x, p.z);
    this.manager.add(this.curio);
    this.events.emit('curio', { type: 'placed', kind, x: p.x, z: p.z });
    this.emitSound({ kind: 'plop', x: p.x, z: p.z, loud: 0.3, sourceId: this.curio.name });
    this.touched();
  }

  removeCurio(): void {
    if (!this.curio) return;
    const c = this.curio;
    this.events.emit('curio', { type: 'removed', kind: c.kind, x: c.position.x, z: c.position.z });
    this.manager.remove(c);
    this.kinling.senses.forget(c);
    this.curio = null;
  }

  /** A whistle or a taught cue, sounded from where the player is. */
  cue(kind: CueKind): void {
    this.touched();
    this.events.emit('sound', { kind: kind === 'come' ? 'whistle' : 'cue', x: this.playerSpot.x, z: this.playerSpot.z, loud: 0.45 });
    const k = this.kinling;
    const d = Math.hypot(this.playerSpot.x - k.position.x, this.playerSpot.z - k.position.z);
    this.manager.sendMessage(this.source, k, MSG.CUE, 0.12 + d * 0.012, { kind });
  }

  touch(region: TouchRegion, kind: 'stroke' | 'tap', x: number, y: number, z: number): void {
    this.touched();
    this.manager.sendMessage(this.source, this.kinling, MSG.TOUCH, 0, { region, kind, x, y, z });
  }

  setWisp(on: boolean, x = 0, z = 0): void {
    const w = this.wisp;
    if (on) {
      const p = isWalkable(x, z, 0.1) ? { x, z } : nearestWalkable(x, z, 0.1);
      w.target.set(p.x, 0, p.z);
      if (!w.on) {
        w.position.set(p.x, heightAt(p.x, p.z) + w.hover, p.z);
        w.on = true;
      }
      this.touched();
    } else if (w.on) {
      w.on = false;
      this.kinling.senses.forget(w);
    }
  }
}
