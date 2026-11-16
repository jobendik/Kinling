/**
 * Perception. The creature never reads object positions straight from the
 * world to make decisions: it keeps Yuka MemoryRecords of what it has
 * actually sensed. Sight uses Yuka Vision from the head (so the head has to
 * turn to see), with rocks, the log and tree trunks as occluders. Hearing
 * gives an imprecise position without sight; smell works at nose range.
 */
import { GameEntity, MemoryRecord, MemorySystem, Vector3, Vision } from 'yuka';
import { Berry, Curio, Toy, Wisp } from '../entities';
import type { SoundEvent } from '../types';
import type { Kinling } from './Kinling';

export const SIGHT_RANGE = 9;
export const SIGHT_FOV = 3.6;
export const SMELL_RANGE = 0.75;
export const SHORT_TERM_SPAN_S = 30;

const point = new Vector3();

export class Senses {
  readonly vision: Vision;
  readonly memory: MemorySystem;
  private timer = 0;
  private scratch: MemoryRecord[] = [];

  constructor(private k: Kinling) {
    this.vision = new Vision(k.headEntity);
    this.vision.fieldOfView = SIGHT_FOV;
    this.vision.range = SIGHT_RANGE;
    for (const o of k.world.obstacles) this.vision.addObstacle(o);
    this.memory = new MemorySystem(k);
    this.memory.memorySpan = SHORT_TERM_SPAN_S;
  }

  private sensables(): GameEntity[] {
    const w = this.k.world;
    const list: GameEntity[] = [];
    for (const t of Object.values(w.toys)) if (t.state !== 'carried') list.push(t);
    for (const b of w.berries) if (!b.eaten) list.push(b);
    if (w.curio) list.push(w.curio);
    if (w.wisp.on) list.push(w.wisp);
    return list;
  }

  update(dt: number): void {
    if ((this.timer -= dt) > 0) return;
    this.timer = 0.1;
    for (const e of this.sensables()) this.sense(e);
  }

  private sense(e: GameEntity): void {
    const k = this.k;
    const now = k.now;
    const d = k.distanceTo(e.position.x, e.position.z);
    point.copy(e.position);
    point.y += 0.04;
    const sensed = !k.asleep && (d < SMELL_RANGE || this.vision.visible(point));
    let rec = this.memory.getRecord(e);
    if (!rec) {
      if (!sensed) return;
      this.memory.createRecord(e);
      rec = this.memory.getRecord(e)!;
    }
    if (!sensed) { rec.visible = false; return; }
    const first = rec.timeLastSensed === -Infinity;
    const gap = now - rec.timeLastSensed;
    const moved = first ? 0 : rec.lastSensedPosition.distanceTo(e.position);
    const was = rec.visible;
    rec.timeLastSensed = now;
    rec.lastSensedPosition.copy(e.position);
    rec.visible = true;
    if (!was) {
      rec.timeBecameVisible = now;
      if (first || gap > 2.5) k.brain.onNotice(e, { first, moved: moved > 0.9 });
    }
    if (e instanceof Toy) k.ltm.sawAt(e.name, e.position.x, e.position.z, now);
  }

  /** A sound gives away roughly where its source is, without seeing it. */
  hear(e: SoundEvent & { distance: number }): void {
    if (!e.sourceId) return;
    const w = this.k.world;
    const src: GameEntity | null =
      e.sourceId === 'ball' ? w.toys.ball : e.sourceId === 'rattle' ? w.toys.rattle : w.curio && e.sourceId === w.curio.name ? w.curio : null;
    if (!src) return;
    if (!this.memory.hasRecord(src)) this.memory.createRecord(src);
    const rec = this.memory.getRecord(src)!;
    if (rec.visible) return;
    const err = 0.15 + e.distance * 0.08;
    rec.lastSensedPosition.set(e.x + this.k.rng.range(-err, err), src.position.y, e.z + this.k.rng.range(-err, err));
    rec.timeLastSensed = this.k.now;
  }

  sees(e: GameEntity): boolean {
    return this.memory.getRecord(e)?.visible === true;
  }

  /** Seconds since last sensed (Infinity if never). */
  age(e: GameEntity): number {
    const r = this.memory.getRecord(e);
    return r ? this.k.now - r.timeLastSensed : Infinity;
  }

  /**
   * Where the creature thinks something is: short-term memory first, then
   * (for toys) the long-term "where I last saw it".
   */
  believed(e: GameEntity): { x: number; z: number; fresh: boolean } | null {
    const r = this.memory.getRecord(e);
    if (r && this.k.now - r.timeLastSensed <= SHORT_TERM_SPAN_S) return { x: r.lastSensedPosition.x, z: r.lastSensedPosition.z, fresh: true };
    if (e instanceof Toy) {
      const w = this.k.ltm.lastSeen(e.name);
      if (w) return { x: w.x, z: w.z, fresh: false };
    }
    return null;
  }

  /** Records still within the short-term span (for the inspector). */
  current(): MemoryRecord[] {
    return this.memory.getValidMemoryRecords(this.k.now, this.scratch);
  }

  nearestBerry(): Berry | null {
    let best: Berry | null = null, bd = Infinity;
    for (const b of this.k.world.berries) {
      if (b.eaten) continue;
      const bel = this.believed(b);
      if (!bel) continue;
      const d = this.k.distanceTo(bel.x, bel.z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  forget(e: GameEntity): void {
    if (this.memory.hasRecord(e)) this.memory.deleteRecord(e);
  }

  static describe(e: GameEntity): string {
    if (e instanceof Toy) return e.kind;
    if (e instanceof Berry) return 'berry';
    if (e instanceof Curio) return e.kind;
    if (e instanceof Wisp) return 'wisp';
    return e.name || 'thing';
  }
}
