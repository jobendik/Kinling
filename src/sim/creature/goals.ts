/**
 * Goals. Small atomic goals (go somewhere, face something, perform an
 * action, wait) are composed into the creature's activities with Yuka's
 * CompositeGoal. Every activity handles completion, failure, interruption
 * and cleanup, so being cut off mid-way always leaves a valid body and
 * world state (travel stopped, action cancelled, carried toy released).
 */
import { CompositeGoal, GameEntity, Goal } from 'yuka';
import { clamp01 } from '../../core/math';
import { Berry, Curio, Toy } from '../entities';
import { BUSH, nearestShore, nearestWalkable, POND, isWalkable, GLADE_RADIUS, walkableSegment } from '../terrain';
import type { ActionKind, ActivityId, CueKind, MoveStyle, Vec2 } from '../types';
import type { Kinling } from './Kinling';
import { ACTIONS } from './Kinling';
import { Senses } from './senses';

const S = Goal.STATUS;
type Point = () => Vec2 | null;

// ─────────────────────────────────────────────────────────────────
// Atomic goals
// ─────────────────────────────────────────────────────────────────

/** Walk to a (possibly moving) point along a planned path. Fails if unreachable or stuck. */
export class GoTo extends Goal<Kinling> {
  private dest: Vec2 | null = null;
  private t = 0;
  private replans = 0;
  why = '';
  constructor(k: Kinling, private target: Point, private o: { style: MoveStyle | (() => MoveStyle); arrive?: number; timeout?: number; look?: boolean }) {
    super(k);
  }
  private style(): MoveStyle {
    return typeof this.o.style === 'function' ? this.o.style() : this.o.style;
  }
  override activate(): void {
    this.t = 0;
    this.dest = null;
  }
  override execute(): void {
    const k = this.owner!;
    this.t += k.dt;
    if (k.mode === 'SETTLED') { k.rise(); return; }
    if (!k.canMove) return;
    const p = this.target();
    const arrive = this.o.arrive ?? 0.25;
    if (!p) { this.why = 'no target'; this.status = S.FAILED; return; }
    if (k.distanceTo(p.x, p.z) <= arrive) { k.stopTravel(); this.status = S.COMPLETED; return; }
    const moved = this.dest ? Math.hypot(p.x - this.dest.x, p.z - this.dest.z) : Infinity;
    if (k.travel.kind !== 'path' || moved > 0.5) {
      if (!k.travelTo(p.x, p.z, this.style(), arrive)) { this.why = 'unreachable'; this.status = S.FAILED; return; }
      this.dest = { x: p.x, z: p.z };
    } else k.style = this.style();
    if (k.arrived()) {
      // the path ended as close as it can get; good enough if the target is near
      k.stopTravel();
      if (k.distanceTo(p.x, p.z) <= arrive + 0.45) this.status = S.COMPLETED;
      else { this.why = 'unreachable'; this.status = S.FAILED; }
      return;
    }
    if (k.stuckT > 2.2) {
      if (this.replans++ < 1) { this.dest = null; k.stuckT = 0; }
      else { this.why = 'stuck'; this.status = S.FAILED; return; }
    }
    if (this.t > (this.o.timeout ?? 40)) { this.why = 'timeout'; this.status = S.FAILED; return; }
    if (this.o.look) k.look(p.x, 0.1, p.z, 0.4, 0);
  }
  override terminate(): void {
    this.owner!.stopTravel();
  }
}

/** Chase something that may be moving. Uses sight when it has it, belief when it does not. */
export class Pursue extends Goal<Kinling> {
  private t = 0;
  private dest: Vec2 | null = null;
  why = '';
  constructor(k: Kinling, private e: GameEntity, private o: { style: MoveStyle | (() => MoveStyle); reach: number; timeout?: number }) {
    super(k);
  }
  override activate(): void {
    this.t = 0;
    this.dest = null;
  }
  override execute(): void {
    const k = this.owner!;
    this.t += k.dt;
    if (k.mode === 'SETTLED') { k.rise(); return; }
    if (!k.canMove) return;
    const style = typeof this.o.style === 'function' ? this.o.style() : this.o.style;
    const bel = k.senses.believed(this.e);
    if (!bel) { this.why = 'unknown'; this.status = S.FAILED; return; }
    if (k.senses.sees(this.e)) {
      const p = this.e.position;
      k.look(p.x, p.y, p.z, 0.4, 1);
      if (k.distanceTo(p.x, p.z) <= this.o.reach) { k.stopTravel(); this.status = S.COMPLETED; return; }
      if (walkableSegment(k.position.x, k.position.z, p.x, p.z, 0.17)) {
        if (k.travel.kind !== 'pursue') k.travelPursue(this.e, style, this.o.reach * 0.8);
        else k.style = style;
        this.dest = null;
      } else if (k.travel.kind !== 'path' || !this.dest || Math.hypot(p.x - this.dest.x, p.z - this.dest.z) > 0.5) {
        if (!k.travelTo(p.x, p.z, style, this.o.reach * 0.8)) { this.why = 'unreachable'; this.status = S.FAILED; return; }
        this.dest = { x: p.x, z: p.z };
      }
    } else {
      if (k.travel.kind !== 'path' || !this.dest || Math.hypot(bel.x - this.dest.x, bel.z - this.dest.z) > 0.6) {
        if (!k.travelTo(bel.x, bel.z, style, 0.35)) { this.why = 'unreachable'; this.status = S.FAILED; return; }
        this.dest = { x: bel.x, z: bel.z };
      }
      if (k.arrived()) { k.stopTravel(); this.why = 'not there'; this.status = S.FAILED; return; }
    }
    if (k.stuckT > 2.5) { this.why = 'stuck'; this.status = S.FAILED; return; }
    if (this.t > (this.o.timeout ?? 25)) { this.why = 'timeout'; this.status = S.FAILED; }
  }
  override terminate(): void {
    this.owner!.stopTravel();
  }
}

export class Face extends Goal<Kinling> {
  private t = 0;
  constructor(k: Kinling, private target: Point, private tolerance = 0.3) {
    super(k);
  }
  override activate(): void {
    this.t = 0;
  }
  override execute(): void {
    const k = this.owner!;
    this.t += k.dt;
    const p = this.target();
    if (!p || k.mode === 'SETTLED' || this.t > 2.5) { this.status = S.COMPLETED; return; }
    if (!k.canMove) return;
    k.face(p.x, p.z);
    if (k.facing(p.x, p.z, this.tolerance)) this.status = S.COMPLETED;
  }
  override terminate(): void {
    this.owner!.faceTarget = null;
  }
}

/** Perform one action through the body state machine. */
export class Do extends Goal<Kinling> {
  private started = false;
  private done = false;
  private ok = false;
  private wait = 0;
  constructor(
    k: Kinling,
    private kind: ActionKind,
    private o: { target?: () => { x: number; y: number; z: number } | null; onContact?: (i: number) => void; onEnd?: (ok: boolean) => void; optional?: boolean } = {},
  ) {
    super(k);
  }
  override activate(): void {
    this.started = this.done = this.ok = false;
    this.wait = 0;
  }
  override execute(): void {
    const k = this.owner!;
    if (!this.started) {
      if (ACTIONS[this.kind].standing && k.mode === 'SETTLED') k.rise();
      const started = k.perform(this.kind, {
        target: this.o.target?.() ?? null,
        onContact: this.o.onContact,
        onEnd: (ok) => { this.done = true; this.ok = ok; this.o.onEnd?.(ok); },
      });
      if (started) this.started = true;
      else if ((this.wait += k.dt) > 3) this.status = this.o.optional ? S.COMPLETED : S.FAILED;
      return;
    }
    if (this.done) this.status = this.ok || this.o.optional ? S.COMPLETED : S.FAILED;
  }
  override terminate(): void {
    if (this.started && !this.done) this.owner!.cancelAction();
  }
}

export class Settle extends Goal<Kinling> {
  private t = 0;
  constructor(k: Kinling, private posture: 'sit' | 'lie') {
    super(k);
  }
  override activate(): void {
    this.t = 0;
  }
  override execute(): void {
    const k = this.owner!;
    this.t += k.dt;
    if (k.mode === 'FREE' || k.mode === 'SETTLED') {
      if (k.riseT > 0) return;
      k.stopTravel();
      k.settle(this.posture);
      if (k.settled && k.posture === this.posture) this.status = S.COMPLETED;
    }
    if (this.t > 6) this.status = S.FAILED;
  }
}

export class Wait extends Goal<Kinling> {
  private t = 0;
  constructor(k: Kinling, private seconds: number, private o: { until?: () => boolean; tick?: (t: number) => void } = {}) {
    super(k);
  }
  override activate(): void {
    this.t = 0;
  }
  override execute(): void {
    this.t += this.owner!.dt;
    this.o.tick?.(this.t);
    if (this.t >= this.seconds || this.o.until?.()) this.status = S.COMPLETED;
  }
}

export class Call extends Goal<Kinling> {
  constructor(k: Kinling, private fn: () => void) {
    super(k);
  }
  override execute(): void {
    this.fn();
    this.status = S.COMPLETED;
  }
}

/** Amble with Yuka's wander steering for a while. */
export class Meander extends Goal<Kinling> {
  private t = 0;
  constructor(k: Kinling, private seconds: number, private style: MoveStyle) {
    super(k);
  }
  override activate(): void {
    this.t = 0;
  }
  override execute(): void {
    const k = this.owner!;
    if (k.mode === 'SETTLED') { k.rise(); return; }
    if (!k.canMove) return;
    if (k.travel.kind !== 'wander') k.travelWander(this.style);
    this.t += k.dt;
    if (this.t >= this.seconds) { k.stopTravel(); this.status = S.COMPLETED; }
  }
  override terminate(): void {
    this.owner!.stopTravel();
  }
}

/**
 * Look for something that is not where it was believed to be: scan, then
 * check a few plausible spots (favouring the far side of whatever blocks the
 * view). Succeeds on sight, gives up when patience runs out.
 */
export class Search extends Goal<Kinling> {
  private t = 0;
  private probes: Vec2[] = [];
  private scanT = 0;
  private moving = false;
  constructor(k: Kinling, private e: GameEntity, private patience: number) {
    super(k);
  }
  override activate(): void {
    const k = this.owner!;
    this.t = 0;
    this.scanT = 0;
    this.moving = false;
    this.probes = [];
    const bel = k.senses.believed(this.e) ?? { x: k.position.x, z: k.position.z };
    // behind the nearest sight-blocking obstacle
    let nearest: { x: number; z: number; r: number } | null = null, nd = 3.2;
    for (const o of k.world.obstacles) {
      if (o.def.h < 0.42) continue;
      const d = Math.hypot(o.def.x - bel.x, o.def.z - bel.z);
      if (d < nd) { nd = d; nearest = o.def; }
    }
    if (nearest) {
      const dx = nearest.x - k.position.x, dz = nearest.z - k.position.z;
      const l = Math.hypot(dx, dz) || 1;
      this.probes.push(nearestWalkable(nearest.x + (dx / l) * (nearest.r + 0.6), nearest.z + (dz / l) * (nearest.r + 0.6)));
    }
    const a0 = k.rng.range(0, Math.PI * 2);
    for (let i = 0; i < 2; i++) {
      const a = a0 + i * 2.4;
      const px = bel.x + Math.sin(a) * 1.5, pz = bel.z + Math.cos(a) * 1.5;
      if (isWalkable(px, pz)) this.probes.push({ x: px, z: pz });
    }
    k.vocal('sniff', 0.4);
  }
  override execute(): void {
    const k = this.owner!;
    this.t += k.dt;
    if (k.senses.sees(this.e)) { k.stopTravel(); k.affect.feel(0.08, 0.15); this.status = S.COMPLETED; return; }
    if (this.t > this.patience) { this.status = S.FAILED; return; }
    if (k.mode === 'SETTLED') { k.rise(); return; }
    if (!k.canMove) return;
    if (!this.moving) {
      // stand and sweep the head from side to side
      this.scanT += k.dt;
      const side = Math.sin(this.scanT * 2.6) * 2.2;
      const yaw = k.heading + side;
      k.look(k.position.x + Math.sin(yaw) * 3, 0.2, k.position.z + Math.cos(yaw) * 3, 0.3, 1);
      if (this.scanT > 1.8) {
        const next = this.probes.shift();
        if (!next) { this.status = S.FAILED; return; }
        if (k.travelTo(next.x, next.z, 'walk', 0.3)) this.moving = true;
        this.scanT = 0;
      }
    } else if (k.arrived() || k.stuckT > 2 || k.travel.kind !== 'path') {
      k.stopTravel();
      this.moving = false;
      this.scanT = 0;
    }
  }
  override terminate(): void {
    this.owner!.stopTravel();
  }
}

// ─────────────────────────────────────────────────────────────────
// Activities
// ─────────────────────────────────────────────────────────────────

export type Outcome = 'done' | 'failed' | 'interrupted';

export abstract class Activity extends CompositeGoal<Kinling> {
  abstract readonly label: string;
  /** Short human-readable note about the current phase, for the inspector. */
  phase = '';
  startedAt = 0;
  protected finished = false;
  protected readonly k: Kinling;
  constructor(k: Kinling) {
    super(k);
    this.k = k;
  }
  protected abstract begin(): void;
  /** All queued subgoals finished. Queue more and return true to continue. */
  protected advance(): boolean {
    return false;
  }
  /** A subgoal failed. Queue a recovery and return true, or return false to fail. */
  protected recover(_failed: Goal<Kinling>): boolean {
    return false;
  }
  protected tick(): void {}
  protected cleanup(_outcome: Outcome): void {}
  protected seq(...goals: Goal<Kinling>[]): void {
    for (const g of goals) this.addSubgoal(g);
  }
  override activate(): void {
    this.clearSubgoals();
    this.startedAt = this.k.now;
    this.begin();
  }
  override execute(): void {
    this.activateIfInactive();
    if (this.status !== S.ACTIVE) return;
    const current = this.currentSubgoal();
    const s = this.executeSubgoals();
    if (s === S.COMPLETED) this.status = this.advance() ? S.ACTIVE : S.COMPLETED;
    else if (s === S.FAILED) this.status = current && this.recover(current) ? S.ACTIVE : S.FAILED;
    if (this.status === S.ACTIVE) this.tick();
  }
  override terminate(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearSubgoals();
    this.cleanup(this.status === S.COMPLETED ? 'done' : this.status === S.FAILED ? 'failed' : 'interrupted');
    this.k.brain.activityEnded(this);
  }
  describe(): string[] {
    return this.subgoals.map((g) => g.constructor.name).reverse();
  }
}

const groundOf = (k: Kinling, p: Vec2): { x: number; y: number; z: number } => ({ x: p.x, y: k.position.y + 0.03, z: p.z });

export class EatGoal extends Activity {
  readonly label = 'eat';
  private berry: Berry | null = null;
  ate = false;
  protected begin(): void {
    const k = this.k;
    this.berry = k.senses.nearestBerry();
    const hungry = k.needs.urgency('nourishment');
    const style: MoveStyle = hungry > 0.6 ? 'trot' : 'walk';
    if (this.berry) {
      const b = this.berry;
      this.phase = 'going to a berry';
      const at: Point = () => k.senses.believed(b);
      this.seq(
        new GoTo(k, at, { style, arrive: 0.44, look: true }),
        new Face(k, at, 0.25),
        new Do(k, 'sniff', { target: () => { const p = at(); return p ? groundOf(k, p) : null; }, optional: true, onContact: () => k.vocal('sniff', 0.3) }),
        new Do(k, 'eat', {
          target: () => ({ x: b.position.x, y: b.position.y, z: b.position.z }),
          onContact: (i) => {
            const m = k.mouth;
            if (i === 0) {
              if (b.eaten || Math.hypot(b.position.x - m.x, b.position.z - m.z) > 0.42) { k.senses.forget(b); k.cancelAction(); return; }
              k.world.removeBerry(b);
              k.world.events.emit('berry', { type: 'eaten', x: b.position.x, z: b.position.z });
              this.consume(0.25, b);
            }
            k.vocal('munch', 0.5, 0.2);
          },
        }),
      );
    } else if (k.world.bushStock > 0) {
      this.phase = 'foraging at the berry bush';
      const d = Math.hypot(BUSH.x, BUSH.z) || 1;
      const spot = nearestWalkable(BUSH.x - (BUSH.x / d) * (BUSH.r + 0.36), BUSH.z - (BUSH.z / d) * (BUSH.r + 0.36));
      this.seq(
        new GoTo(k, () => spot, { style, arrive: 0.2, look: true }),
        new Face(k, () => BUSH, 0.25),
        new Do(k, 'eat', {
          target: () => ({ x: BUSH.x, y: k.position.y + 0.28, z: BUSH.z }),
          onContact: (i) => {
            if (i === 0) {
              if (k.world.bushStock <= 0) { k.cancelAction(); return; }
              k.world.bushStock--;
              k.world.events.emit('berry', { type: 'eaten', x: BUSH.x, z: BUSH.z });
              k.world.events.emit('rustle', { x: BUSH.x, z: BUSH.z, strength: 0.6 });
              this.consume(0.2, null);
            }
            k.vocal('munch', 0.5, 0.2);
          },
        }),
      );
    } else {
      // nothing to eat that it knows of: ask
      this.phase = 'asking for food';
      const fed = k.ltm.recall('fed');
      const spot: Vec2 = fed ? nearestWalkable(fed.x, fed.z) : k.world.playerSpot;
      this.seq(
        new GoTo(k, () => spot, { style: 'walk', arrive: 0.5 }),
        new Face(k, () => ({ x: k.world.playerSpot.x * 1.3, z: k.world.playerSpot.z * 1.3 + 1 })),
        new Settle(k, 'sit'),
        new Do(k, 'pawAt', { optional: true, onContact: () => k.vocal('whine', 0.5) }),
        new Wait(k, 6, { until: () => k.senses.nearestBerry() !== null, tick: () => k.lookAtPlayer(0.5, 1) }),
      );
    }
  }
  private consume(amount: number, b: Berry | null): void {
    const k = this.k;
    this.ate = true;
    k.needs.add('nourishment', amount);
    k.affect.feel(0.09, 0.03, -0.04);
    k.stats.berries++;
    k.learn.familiarise('berry', 0.5);
    if (b?.fromPlayer && k.now - b.bornAt < 120) {
      k.learn.adjustBond(0.02, 'was given a berry');
      k.brain.onReward('food');
      k.ltm.record({ kind: 'fed', subject: 'berry', x: b.position.x, z: b.position.z, t: k.now, wall: Date.now(), valence: 0.6, note: 'was given a berry here' });
    } else {
      k.ltm.record({ kind: 'ate', subject: 'berry', x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: 0.3, salience: 0.18, note: 'found something to eat' });
    }
  }
}

export class DrinkGoal extends Activity {
  readonly label = 'drink';
  drank = 0;
  protected begin(): void {
    const k = this.k;
    const shore = nearestShore(k.position.x, k.position.z);
    this.phase = 'going to the pond';
    this.seq(
      new GoTo(k, () => shore, { style: k.needs.urgency('hydration') > 0.6 ? 'trot' : 'walk', arrive: 0.14, look: true }),
      new Face(k, () => POND, 0.2),
      new Do(k, 'drink', {
        target: () => ({ x: k.mouth.x, y: k.position.y - 0.02, z: k.mouth.z }),
        onContact: () => {
          const m = k.mouth;
          this.drank++;
          k.needs.add('hydration', 0.115);
          k.world.events.emit('ripple', { x: m.x, z: m.z, strength: 0.35 });
          k.vocal('lap', 0.4, 0.2);
        },
        onEnd: (ok) => {
          if (ok) {
            k.affect.feel(0.05, 0, -0.02);
            k.ltm.record({ kind: 'drank', subject: 'pond', x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: 0.25, salience: 0.15, note: 'drank at the pond' });
          }
        },
      }),
    );
  }
}

export class RestGoal extends Activity {
  readonly label = 'rest';
  private stage: 'going' | 'settling' | 'asleep' | 'loafing' | 'waking' = 'going';
  private place = { x: 0, z: 0, label: 'spot' };
  private sleptAt = 0;
  private disturbed = false;
  protected begin(): void {
    const k = this.k;
    if (k.asleep) { this.stage = 'asleep'; this.sleptAt = k.now; this.place = { x: k.position.x, z: k.position.z, label: 'spot' }; this.phase = 'asleep'; this.seq(this.sleepWatch()); return; }
    const p = k.learn.restPlace(k.position.x, k.position.z, k.world.night);
    this.place = { x: p.x, z: p.z, label: p.label };
    this.phase = `heading to the ${p.label}`;
    this.stage = 'going';
    this.seq(
      new GoTo(k, () => this.place, { style: k.needs.values.energy < 0.3 ? 'tired' : 'amble', arrive: 0.3 }),
      new Do(k, 'knead', { optional: true, onContact: () => k.world.events.emit('rustle', { x: k.position.x, z: k.position.z, strength: 0.25 }) }),
      new Settle(k, 'lie'),
    );
  }
  private sleepWatch(): Goal<Kinling> {
    return new Wait(this.k, 1e9, { until: () => !this.k.asleep });
  }
  protected override advance(): boolean {
    const k = this.k;
    if (this.stage === 'going') {
      const sleepy = k.needs.values.energy < 0.45 || k.world.night > 0.5;
      if (sleepy && k.affect.wariness < 0.4) {
        this.stage = 'settling';
        this.phase = 'dozing off';
        this.seq(
          new Wait(k, 1.5 + k.rng.range(0, 2)),
          new Do(k, 'yawn', { optional: true, onContact: () => k.vocal('yawn', 0.5) }),
          new Wait(k, 1.2),
          new Call(k, () => { k.fallAsleep(); this.sleptAt = k.now; this.stage = 'asleep'; this.phase = 'asleep'; }),
          this.sleepWatch(),
        );
      } else {
        this.stage = 'loafing';
        this.phase = 'resting';
        this.seq(new Wait(k, 9 + k.rng.range(0, 9), { until: () => k.needs.values.energy > 0.85 }));
      }
      return true;
    }
    if (this.stage === 'settling') return false;
    if (this.stage === 'asleep') {
      this.noteNap();
      this.stage = 'waking';
      this.phase = 'waking up';
      const how = k.brain.wokeBy;
      this.seq(new Wait(k, 1.9), new Do(k, how === 'rested' ? 'stretch' : 'yawn', { optional: true, onContact: () => k.vocal('yawn', 0.4) }));
      if (how === 'rested' && k.rng.chance(0.6)) this.seq(new Do(k, 'shake', { optional: true }));
      return true;
    }
    return false;
  }
  private noteNap(): void {
    const k = this.k;
    const dur = k.now - this.sleptAt;
    if (this.sleptAt <= 0 || dur < 6) return;
    const how = k.brain.wokeBy;
    const quality = clamp01((how === 'rested' ? 0.85 : how === 'need' ? 0.65 : how === 'touch' ? 0.5 : 0.2) - (this.disturbed ? 0.3 : 0));
    k.ltm.record({ kind: 'nap', subject: this.place.label, x: this.place.x, z: this.place.z, t: k.now, wall: Date.now(), valence: quality - 0.3, note: quality > 0.6 ? `slept well at the ${this.place.label}` : `was woken at the ${this.place.label}` });
    k.learn.reinforcePlace(this.place.x, this.place.z, quality, this.place.label);
    k.ltm.consolidate();
    this.sleptAt = 0;
  }
  protected override cleanup(outcome: Outcome): void {
    if (outcome === 'interrupted' && this.stage === 'asleep') { this.disturbed = true; this.k.brain.wokeBy = 'noise'; this.noteNap(); }
  }
}

/** Shared bookkeeping for play: enjoyment is measured, then learned from. */
abstract class PlayActivity extends Activity {
  catches = 0;
  bats = 0;
  playerThrows = 0;
  lost = false;
  abstract readonly activity: ActivityId;
  protected override tick(): void {
    // play is stimulating while it lasts
    this.k.needs.add('stimulation', this.k.dt * 0.022);
  }
  protected enjoyment(): number {
    const k = this.k;
    const fatigue = 1 - k.needs.values.energy;
    return clamp01(
      0.26 + 0.17 * Math.min(this.catches, 4) + 0.05 * Math.min(this.bats, 4) + (this.playerThrows > 0 ? 0.16 : 0) + 0.05 * Math.min(this.playerThrows, 3)
      - (this.lost ? 0.3 : 0) - 0.22 * Math.max(0, fatigue - 0.5) + 0.08 * k.affect.valence,
    );
  }
  protected override cleanup(outcome: Outcome): void {
    const k = this.k;
    k.playing = false;
    if (k.carrying) k.release(0.2);
    const dur = k.now - this.startedAt;
    if (dur < 2.5 && this.catches + this.bats === 0 && !this.lost) return; // nothing really happened
    const e = this.enjoyment();
    k.learn.updateAffinity(this.activity, e);
    k.affect.feel((e - 0.4) * 0.3, 0, 0);
    if (this.lost) {
      k.ltm.record({ kind: 'lostToy', subject: this.activity, x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: -0.3, note: `could not find the ${this.activity}` });
    } else {
      k.ltm.record({ kind: 'play', subject: this.activity, x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: e - 0.25, note: `${this.activity} play (${this.catches} catches${this.playerThrows ? ', with you' : ''})` });
    }
    if (e > 0.6) k.learn.shiftTrait('playfulness', 0.004, 'a good game');
    if (this.playerThrows > 0 && outcome !== 'failed') k.learn.adjustBond(0.012, 'played together');
    void outcome;
  }
}

/** Chase a thrown toy, catch it, and (depending on who it is) bring it back, bring it halfway, or carry it off. */
export class FetchGoal extends PlayActivity {
  readonly label: string;
  readonly activity: ActivityId;
  private stage: 'chase' | 'pounce' | 'pickup' | 'return' | 'home' | 'search' = 'chase';
  private caught = false;
  private attempts = 0;
  private dropAt = 0;
  private lastThrow: number;
  constructor(k: Kinling, readonly toy: Toy) {
    super(k);
    this.label = `fetch ${toy.kind}`;
    this.activity = toy.kind;
    this.lastThrow = toy.thrownAt;
  }
  protected begin(): void {
    const k = this.k;
    k.playing = true;
    this.playerThrows = k.now - this.toy.thrownAt < 12 ? 1 : 0;
    this.chase();
  }
  private chase(): void {
    const k = this.k;
    this.stage = 'chase';
    this.phase = `chasing the ${this.toy.kind}`;
    this.seq(new Pursue(k, this.toy, { style: () => (k.needs.values.energy > 0.3 ? 'run' : 'trot'), reach: 0.55, timeout: 20 }));
  }
  protected override advance(): boolean {
    const k = this.k, toy = this.toy;
    const at = (): Vec2 => ({ x: toy.position.x, z: toy.position.z });
    switch (this.stage) {
      case 'search':
        this.chase();
        return true;
      case 'chase':
        this.stage = 'pounce';
        this.phase = 'pouncing';
        this.caught = false;
        this.seq(
          new Face(k, at, 0.35),
          new Do(k, 'pounce', {
            target: () => ({ x: toy.position.x, y: toy.position.y, z: toy.position.z }),
            onContact: () => {
              if (k.distanceTo(toy.position.x, toy.position.z) < 0.5 && toy.state === 'free') {
                this.caught = true;
                this.catches++;
                k.stats.catches++;
                toy.velocity.multiplyScalar(0.15);
                k.needs.add('stimulation', 0.1);
                k.affect.feel(0.08, 0.1);
                k.vocal('trill', 0.6);
              }
            },
          }),
        );
        return true;
      case 'pounce':
        if (!this.caught && this.attempts++ < 4) { this.chase(); return true; }
        if (!this.caught) return false;
        this.stage = 'pickup';
        this.phase = 'picking it up';
        this.seq(
          new Pursue(k, toy, { style: 'walk', reach: 0.42, timeout: 6 }),
          new Face(k, at, 0.3),
          new Do(k, 'pickup', {
            target: () => ({ x: toy.position.x, y: toy.position.y, z: toy.position.z }),
            onContact: () => { if (toy.state === 'free' && k.distanceTo(toy.position.x, toy.position.z) < 0.55) k.take(toy); },
          }),
        );
        return true;
      case 'pickup': {
        if (k.carrying !== toy) { if (this.attempts++ < 5) { this.chase(); return true; } return false; }
        // its own decision about what to do with the prize
        const bond = k.learn.data.bond;
        const retrieve = clamp01(0.3 + 0.55 * bond + 0.2 * k.traits.sociability + (this.playerThrows > 0 ? 0.15 : -0.2));
        const roll = k.rng.next();
        if (roll < retrieve) {
          const halfway = k.rng.chance(clamp01(0.5 - bond) * (1 - k.traits.persistence));
          const ps = k.world.playerSpot;
          const spot: Vec2 = halfway ? nearestWalkable((ps.x + k.position.x) / 2, (ps.z + k.position.z) / 2) : ps;
          this.stage = 'return';
          this.phase = halfway ? 'bringing it part of the way' : 'bringing it back';
          this.seq(
            new GoTo(k, () => spot, { style: 'trot', arrive: 0.6 }),
            new Face(k, () => ({ x: ps.x * 1.3, z: ps.z * 1.3 + 1 }), 0.4),
            new Do(k, 'drop', { onContact: () => { k.release(0.35); this.dropAt = k.now; } }),
            new Do(k, 'playBow', { optional: true, onContact: () => k.vocal('chirp', 0.6) }),
            new Wait(k, 6 + 7 * k.traits.persistence, { until: () => toy.thrownAt > this.dropAt, tick: () => k.lookAtPlayer(0.5, 1) }),
          );
        } else {
          const home = k.learn.favouritePlace();
          this.stage = 'home';
          this.phase = `carrying it off to the ${home.label}`;
          this.seq(
            new GoTo(k, () => home, { style: 'trot', arrive: 0.35 }),
            new Settle(k, 'lie'),
            new Do(k, 'gnaw', { optional: true, onContact: () => { k.needs.add('stimulation', 0.04); } }),
            new Call(k, () => {
              k.release(0.1);
              k.ltm.record({ kind: 'play', subject: `${toy.kind}@home`, x: home.x, z: home.z, t: k.now, wall: Date.now(), valence: 0.4, note: `took the ${toy.kind} to the ${home.label}` });
            }),
          );
        }
        return true;
      }
      case 'return':
        if (toy.thrownAt > this.dropAt && toy.thrownAt !== this.lastThrow) {
          this.lastThrow = toy.thrownAt;
          this.playerThrows++;
          this.attempts = 0;
          this.chase();
          return true;
        }
        return false;
      default:
        return false;
    }
  }
  protected override recover(failed: Goal<Kinling>): boolean {
    const k = this.k;
    if (failed instanceof Pursue && failed.why === 'not there' && this.stage !== 'search') {
      this.stage = 'search';
      this.phase = `looking for the ${this.toy.kind}`;
      this.seq(new Search(k, this.toy, 5 + 9 * k.traits.persistence));
      return true;
    }
    if (failed instanceof Search || (failed instanceof Pursue && (failed.why === 'unreachable' || failed.why === 'unknown' || failed.why === 'not there'))) this.lost = true;
    return false;
  }
}

/** Self-directed play: bat a toy, chase it down, pounce, and sometimes carry it somewhere it likes. */
export class SoloPlayGoal extends PlayActivity {
  readonly label: string;
  readonly activity: ActivityId;
  private rounds = 0;
  private stage: 'approach' | 'play' | 'home' | 'search' = 'approach';
  constructor(k: Kinling, readonly toy: Toy) {
    super(k);
    this.label = `play with ${toy.kind}`;
    this.activity = toy.kind;
  }
  protected begin(): void {
    const k = this.k;
    k.playing = true;
    this.stage = 'approach';
    this.phase = `going to the ${this.toy.kind}`;
    this.seq(new Pursue(k, this.toy, { style: 'trot', reach: 0.5, timeout: 20 }));
  }
  private round(): void {
    const k = this.k, toy = this.toy;
    const at = (): Vec2 => ({ x: toy.position.x, z: toy.position.z });
    this.stage = 'play';
    this.phase = `batting the ${toy.kind} about`;
    this.seq(
      new Face(k, at, 0.3),
      new Do(k, 'bat', {
        target: () => ({ x: toy.position.x, y: toy.position.y, z: toy.position.z }),
        onContact: () => {
          if (toy.state !== 'free' || k.distanceTo(toy.position.x, toy.position.z) > 0.6) return;
          // aim back toward the open middle of the glade so the game stays reachable
          const inward = Math.atan2(-toy.position.x, -toy.position.z);
          const a = k.distanceTo(0, 0) > GLADE_RADIUS * 0.55 ? inward + k.rng.range(-0.5, 0.5) : k.heading + k.rng.range(-0.6, 0.6);
          const sp = toy.kind === 'ball' ? k.rng.range(2.2, 3.4) : k.rng.range(1.6, 2.4);
          toy.impulse(Math.sin(a) * sp, 1.3, Math.cos(a) * sp, false);
          k.world.emitSound({ kind: toy.kind === 'rattle' ? 'rattle' : 'bounce', x: toy.position.x, z: toy.position.z, loud: 0.25, sourceId: toy.name });
          this.bats++;
        },
      }),
      new Wait(k, 0.3 + k.rng.range(0, 0.3), { tick: () => k.look(toy.position.x, toy.position.y, toy.position.z, 0.3, 1) }),
      new Do(k, 'wiggle', { optional: true }),
      new Pursue(k, toy, { style: 'run', reach: 0.55, timeout: 12 }),
      new Do(k, 'pounce', {
        target: () => ({ x: toy.position.x, y: toy.position.y, z: toy.position.z }),
        onContact: () => {
          if (k.distanceTo(toy.position.x, toy.position.z) < 0.5 && toy.state === 'free') {
            this.catches++;
            k.stats.catches++;
            toy.velocity.multiplyScalar(0.15);
            k.needs.add('stimulation', 0.09);
            k.vocal('trill', 0.5);
          }
        },
      }),
    );
  }
  protected override advance(): boolean {
    const k = this.k, toy = this.toy;
    if (this.stage === 'home') return false;
    const max = 2 + Math.round(3 * k.traits.persistence);
    if (this.stage === 'approach' || this.stage === 'search' || (this.rounds < max && k.needs.values.energy > 0.22 && k.needs.values.stimulation < 0.93)) {
      this.rounds++;
      this.round();
      return true;
    }
    // a well-liked toy goes home with it
    if (k.learn.data.affinity[this.activity] > 0.55 && k.rng.chance(0.3 + 0.5 * k.learn.data.affinity[this.activity])) {
      const home = k.learn.favouritePlace();
      this.stage = 'home';
      this.phase = `carrying the ${toy.kind} to the ${home.label}`;
      this.seq(
        new Pursue(k, toy, { style: 'walk', reach: 0.42, timeout: 8 }),
        new Do(k, 'pickup', { onContact: () => { if (toy.state === 'free' && k.distanceTo(toy.position.x, toy.position.z) < 0.55) k.take(toy); } }),
        new GoTo(k, () => home, { style: 'trot', arrive: 0.35 }),
        new Settle(k, 'lie'),
        new Do(k, 'gnaw', { optional: true }),
        new Call(k, () => {
          if (k.carrying !== toy) return;
          k.release(0.1);
          k.ltm.record({ kind: 'play', subject: `${toy.kind}@home`, x: home.x, z: home.z, t: k.now, wall: Date.now(), valence: 0.4, note: `took the ${toy.kind} to the ${home.label}` });
        }),
      );
      return true;
    }
    return false;
  }
  protected override recover(failed: Goal<Kinling>): boolean {
    const k = this.k;
    if (failed instanceof Pursue && failed.why === 'not there' && this.stage !== 'search') {
      this.stage = 'search';
      this.phase = `looking for the ${this.toy.kind}`;
      this.seq(new Search(k, this.toy, 5 + 9 * k.traits.persistence));
      return true;
    }
    if (failed instanceof Do) return this.stage === 'play' ? (this.round(), true) : false;
    if (failed instanceof Search || failed instanceof Pursue) this.lost = failed instanceof Search || failed.why !== 'timeout';
    return false;
  }
}

/** Stalk and pounce at the wisp the player leads about. */
export class LureGoal extends PlayActivity {
  readonly label = 'chase wisp';
  readonly activity: ActivityId = 'wisp';
  private rounds = 0;
  protected begin(): void {
    this.k.playing = true;
    this.round();
  }
  private round(): void {
    const k = this.k, w = k.world.wisp;
    this.rounds++;
    this.phase = 'stalking the wisp';
    this.seq(
      new Pursue(k, w, { style: () => (w.velocity.length() > 1.3 || k.distanceTo(w.position.x, w.position.z) > 2.2 ? 'run' : 'sneak'), reach: 0.8, timeout: 14 }),
      new Face(k, () => ({ x: w.position.x, z: w.position.z }), 0.3),
      new Do(k, 'wiggle', { optional: true }),
      new Do(k, 'pounce', {
        target: () => ({ x: w.position.x, y: w.position.y, z: w.position.z }),
        onContact: () => {
          if (w.on && w.escape <= 0 && k.distanceTo(w.position.x, w.position.z) < 0.48) {
            this.catches++;
            k.stats.catches++;
            w.escape = 1.4;
            k.needs.add('stimulation', 0.1);
            k.affect.feel(0.07, 0.1);
            k.vocal('trill', 0.6);
            k.world.events.emit('wisp', { type: 'caught' });
          } else k.world.events.emit('wisp', { type: 'escaped' });
        },
      }),
      new Wait(k, 0.7 + k.rng.range(0, 0.6), { tick: () => k.look(w.position.x, w.position.y, w.position.z, 0.3, 1) }),
    );
  }
  protected override tick(): void {
    super.tick();
    if (!this.k.world.wisp.on) this.status = S.COMPLETED;
  }
  protected override advance(): boolean {
    const k = this.k;
    if (!k.world.wisp.on || k.needs.values.energy < 0.14) return false;
    if (this.catches === 0 && this.rounds > 3 + 6 * k.traits.persistence) return false; // never catching it gets dull
    if (this.rounds > 14) return false;
    this.round();
    return true;
  }
  protected override recover(failed: Goal<Kinling>): boolean {
    if (!this.k.world.wisp.on) return false;
    if (failed instanceof Do && this.rounds < 12) { this.round(); return true; }
    return false;
  }
}

export type Approach = 'bold' | 'wary' | 'timid';

/** Go and find out about something unfamiliar, in a manner that suits its nerve. */
export class InvestigateGoal extends Activity {
  readonly label: string;
  readonly kind: string;
  constructor(k: Kinling, readonly entity: GameEntity, readonly approach: Approach) {
    super(k);
    this.kind = Senses.describe(entity);
    this.label = `investigate ${this.kind}`;
  }
  protected begin(): void {
    const k = this.k, e = this.entity;
    const at: Point = () => k.senses.believed(e);
    const eye = (): { x: number; y: number; z: number } => ({ x: e.position.x, y: e.position.y, z: e.position.z });
    const watch = (): void => k.look(e.position.x, e.position.y, e.position.z, 0.5, 2);
    const learn = (amount: number): Goal<Kinling> => new Call(k, () => { k.learn.familiarise(this.kind, amount); });
    if (this.approach === 'bold') {
      this.phase = `trotting over to the ${this.kind}`;
      this.seq(new GoTo(k, at, { style: 'walk', arrive: 0.46, look: true }), new Face(k, at, 0.25), new Do(k, 'sniff', { target: eye, onContact: () => k.vocal('sniff', 0.4) }), learn(0.6));
      if (e instanceof Toy) this.seq(new Do(k, 'bat', { optional: true, target: eye, onContact: () => this.nudge(e, 1.4) }), new Wait(k, 0.8, { tick: watch }));
    } else if (this.approach === 'wary') {
      this.phase = `approaching the ${this.kind} carefully`;
      this.seq(
        new GoTo(k, at, { style: 'cautious', arrive: 1.5, look: true }),
        new Face(k, at, 0.25),
        new Do(k, 'headTilt', { optional: true }),
        new Wait(k, 0.8 + k.rng.range(0, 1), { tick: watch }),
        new GoTo(k, at, { style: 'cautious', arrive: 0.5, look: true }),
        new Face(k, at, 0.25),
        new Do(k, 'sniff', { target: eye, onContact: () => k.vocal('sniff', 0.4) }),
        learn(0.42),
      );
      if (e instanceof Toy) {
        this.seq(
          new Do(k, 'pawAt', { optional: true, target: eye, onContact: () => {
            this.nudge(e, 0.7);
            // it moved! a little hop back
            k.recoil.x -= Math.sin(k.heading) * 0.9; k.recoil.z -= Math.cos(k.heading) * 0.9;
            k.alert = 1;
          } }),
          new Wait(k, 1, { tick: watch }),
        );
      }
    } else {
      this.phase = `watching the ${this.kind} from a distance`;
      this.seq(
        new GoTo(k, at, { style: 'cautious', arrive: 2.5, look: true }),
        new Face(k, at, 0.25),
        new Settle(k, 'sit'),
        new Wait(k, 4 + k.rng.range(0, 2.5), { tick: watch }),
        learn(0.14),
      );
    }
  }
  private nudge(toy: Toy, speed: number): void {
    const k = this.k;
    if (toy.state !== 'free' || k.distanceTo(toy.position.x, toy.position.z) > 0.65) return;
    toy.impulse(Math.sin(k.heading) * speed, 0.5, Math.cos(k.heading) * speed, false);
  }
  protected override cleanup(outcome: Outcome): void {
    const k = this.k;
    k.brain.investigatedAt[this.kind] = k.now;
    if (outcome !== 'done') return;
    k.ltm.record({ kind: 'discover', subject: this.kind, x: this.entity.position.x, z: this.entity.position.z, t: k.now, wall: Date.now(), valence: this.approach === 'timid' ? 0.05 : 0.3, note: `${this.approach === 'bold' ? 'checked out' : this.approach === 'wary' ? 'carefully sniffed' : 'watched'} the ${this.kind}` });
    k.needs.add('stimulation', 0.08);
    if (this.approach !== 'timid') k.learn.shiftTrait('confidence', 0.005, `faced the ${this.kind}`);
    if (this.entity instanceof Curio && k.learn.familiarity(this.kind) > 0.8) k.learn.shiftTrait('curiosity', 0.004, 'novelty paid off');
  }
}

/** Come to the player for company; sit close if it trusts them, further off if it does not. */
export class SocialGoal extends Activity {
  readonly label = 'seek company';
  private stage: 'approach' | 'enjoy' = 'approach';
  petted = false;
  private pettedNow(): boolean {
    return this.k.now - this.k.touch.at < 1.6 && this.k.touch.liked >= 0;
  }
  protected begin(): void {
    const k = this.k;
    if (this.pettedNow()) { this.enjoy(); return; }
    const ps = k.world.playerSpot;
    const bond = k.learn.data.bond;
    const stand = 0.55 + (1 - bond) * 1.3; // how close it dares to sit
    this.phase = 'coming over for company';
    this.seq(
      new GoTo(k, () => ps, { style: k.needs.urgency('social') > 0.5 ? 'trot' : 'walk', arrive: stand }),
      new Face(k, () => ({ x: ps.x * 1.3, z: ps.z * 1.3 + 1 }), 0.35),
      new Settle(k, 'sit'),
      new Do(k, 'chirp', { optional: true, onContact: () => k.vocal('chirp', 0.6) }),
      new Wait(k, 3.5, { until: () => this.pettedNow(), tick: () => k.lookAtPlayer(0.5, 1) }),
      new Do(k, 'headTilt', { optional: true }),
      new Wait(k, 2.5 + 7 * k.traits.persistence, { until: () => this.pettedNow(), tick: () => k.lookAtPlayer(0.5, 1) }),
    );
  }
  private enjoy(): void {
    const k = this.k;
    this.stage = 'enjoy';
    this.petted = true;
    this.phase = 'being stroked';
    k.stopTravel();
    this.seq(new Wait(k, 90, { until: () => k.now - k.touch.at > 3 || k.touch.liked < 0 }));
  }
  protected override tick(): void {
    if (this.stage === 'approach' && this.pettedNow()) { this.clearSubgoals(); this.enjoy(); }
  }
  protected override advance(): boolean {
    const k = this.k;
    if (this.stage === 'approach') {
      if (this.pettedNow()) { this.enjoy(); return true; }
      // nobody answered
      k.learn.adjustBond(-0.004, 'asked for company and was ignored');
      k.ltm.record({ kind: 'ignored', subject: 'company', x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: -0.15, salience: 0.2, note: 'asked for company; nobody came' });
      return false;
    }
    return false;
  }
}

/** Fetch a favourite toy and offer it to the player. */
export class InviteGoal extends Activity {
  readonly label: string;
  private stage: 'get' | 'offer' | 'search' = 'get';
  private dropAt = 0;
  accepted = false;
  constructor(k: Kinling, readonly toy: Toy) {
    super(k);
    this.label = `offer the ${toy.kind}`;
  }
  protected begin(): void {
    const k = this.k, toy = this.toy;
    this.stage = 'get';
    this.phase = `fetching the ${toy.kind} to offer`;
    this.seq(
      new Pursue(k, toy, { style: 'trot', reach: 0.42, timeout: 25 }),
      new Face(k, () => ({ x: toy.position.x, z: toy.position.z }), 0.3),
      new Do(k, 'pickup', { onContact: () => { if (toy.state === 'free' && k.distanceTo(toy.position.x, toy.position.z) < 0.55) k.take(toy); } }),
    );
  }
  protected override advance(): boolean {
    const k = this.k, toy = this.toy;
    if (this.stage === 'search') { this.begin(); return true; }
    if (this.stage === 'get') {
      if (k.carrying !== toy) return false;
      const ps = k.world.playerSpot;
      this.stage = 'offer';
      this.phase = `bringing you the ${toy.kind}`;
      this.seq(
        new GoTo(k, () => ps, { style: 'trot', arrive: 0.6 }),
        new Face(k, () => ({ x: ps.x * 1.3, z: ps.z * 1.3 + 1 }), 0.4),
        new Do(k, 'drop', { onContact: () => { k.release(0.3); this.dropAt = k.now; } }),
        new Call(k, () => {
          k.ltm.record({ kind: 'gift', subject: toy.kind, x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: 0.3, note: `brought you the ${toy.kind}` });
        }),
        new Do(k, 'playBow', { optional: true, onContact: () => k.vocal('chirp', 0.7) }),
        new Wait(k, 4, { until: () => toy.thrownAt > this.dropAt, tick: () => k.lookAtPlayer(0.5, 1) }),
        new Do(k, 'pawAt', { optional: true }),
        new Wait(k, 3 + 6 * k.traits.persistence, { until: () => toy.thrownAt > this.dropAt, tick: () => k.lookAtPlayer(0.5, 1) }),
      );
      return true;
    }
    this.accepted = toy.thrownAt > this.dropAt && this.dropAt > 0;
    if (!this.accepted) {
      k.learn.adjustBond(-0.004, 'offered a game and was ignored');
      k.ltm.record({ kind: 'ignored', subject: toy.kind, x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: -0.15, salience: 0.2, note: `offered the ${toy.kind}; no game` });
    }
    return false;
  }
  protected override recover(failed: Goal<Kinling>): boolean {
    const k = this.k;
    if (failed instanceof Pursue && failed.why === 'not there' && this.stage === 'get') {
      this.stage = 'search';
      this.phase = `looking for the ${this.toy.kind}`;
      this.seq(new Search(k, this.toy, 5 + 9 * k.traits.persistence));
      return true;
    }
    return false;
  }
  protected override cleanup(): void {
    if (this.k.carrying) this.k.release(0.2);
  }
}

export class ExploreGoal extends Activity {
  readonly label = 'explore';
  protected begin(): void {
    const k = this.k;
    this.phase = 'wandering';
    // pick somewhere worth going: the curious prefer ground they know least
    let best: Vec2 | null = null, bs = -Infinity;
    for (let i = 0; i < 10; i++) {
      const a = k.rng.range(0, Math.PI * 2), r = Math.sqrt(k.rng.next()) * (GLADE_RADIUS - 0.8);
      const p = { x: Math.sin(a) * r, z: Math.cos(a) * r };
      if (!isWalkable(p.x, p.z, 0.3)) continue;
      const s = k.traits.curiosity * (1 - k.learn.exploredAt(p.x, p.z)) + (1 - k.traits.curiosity) * 0.4 + k.rng.next() * 0.25 - 0.035 * k.distanceTo(p.x, p.z);
      if (s > bs) { bs = s; best = p; }
    }
    const dest = best ?? { x: 0, z: 0 };
    this.seq(
      new Meander(k, 2 + k.rng.range(0, 3), 'amble'),
      new GoTo(k, () => dest, { style: k.affect.arousal > 0.55 ? 'walk' : 'amble', arrive: 0.35, look: true, timeout: 30 }),
      new Do(k, 'sniff', { optional: true, target: () => ({ x: k.mouth.x, y: k.position.y, z: k.mouth.z }), onContact: () => k.vocal('sniff', 0.3) }),
      new Wait(k, 1 + k.rng.range(0, 2.5), { tick: (t) => { if (t < 0.1) { const a = k.heading + k.rng.range(-1.6, 1.6); k.look(k.position.x + Math.sin(a) * 4, k.rng.range(0.1, 1.2), k.position.z + Math.cos(a) * 4, 2, 0); } } }),
    );
  }
  protected override recover(): boolean {
    return false;
  }
  protected override cleanup(outcome: Outcome): void {
    if (outcome === 'done') this.k.needs.add('stimulation', 0.04);
  }
}

/** Purposeful stillness and small self-care: sit and watch, groom, stretch, shake off, yawn, chase its tail. */
export class IdleGoal extends Activity {
  readonly label = 'idle';
  protected begin(): void {
    const k = this.k;
    const glance = (): void => {
      const a = k.heading + k.rng.range(-1.8, 1.8);
      k.look(k.position.x + Math.sin(a) * 4, k.rng.range(0.1, 1.6), k.position.z + Math.cos(a) * 4, 1.5 + k.rng.range(0, 2), 0);
    };
    const weights: Array<[string, number]> = [
      ['watch', 1.2],
      ['groom', 0.8],
      ['stretch', k.postureT > 25 || k.mode === 'SETTLED' ? 0.9 : 0.3],
      ['shake', k.inShallows ? 2.5 : 0.25],
      ['yawn', 0.2 + 1.5 * (1 - k.needs.values.energy)],
      ['spin', k.traits.playfulness * (1 - k.needs.values.stimulation) * 1.4 * (k.needs.values.energy > 0.4 ? 1 : 0)],
      ['tilt', 0.3 + k.affect.interest],
    ];
    let total = 0;
    for (const w of weights) total += w[1];
    let r = k.rng.next() * total, pick = 'watch';
    for (const w of weights) { if ((r -= w[1]) <= 0) { pick = w[0]; break; } }
    this.phase = pick;
    let next = 0;
    const idleLook = (t: number): void => { if (t >= next) { glance(); next = t + 1.8 + k.rng.range(0, 2.5); } };
    switch (pick) {
      case 'groom':
        this.seq(new Settle(k, 'sit'), new Do(k, 'groom', { optional: true }), new Wait(k, 1 + k.rng.range(0, 2), { tick: idleLook }));
        break;
      case 'stretch':
        this.seq(new Do(k, 'stretch', { optional: true }), new Wait(k, 1));
        break;
      case 'shake':
        this.seq(new Do(k, 'shake', { optional: true }), new Wait(k, 0.8));
        break;
      case 'yawn':
        this.seq(new Do(k, 'yawn', { optional: true, onContact: () => k.vocal('yawn', 0.4) }), new Wait(k, 1.5, { tick: idleLook }));
        break;
      case 'spin':
        this.seq(new Do(k, 'spin', { optional: true }), new Wait(k, 0.6), new Call(k, () => k.needs.add('stimulation', 0.05)));
        break;
      case 'tilt':
        this.seq(new Call(k, glance), new Do(k, 'headTilt', { optional: true }), new Wait(k, 1.5));
        break;
      default:
        this.seq(new Settle(k, k.rng.chance(0.75) ? 'sit' : 'lie'), new Wait(k, 5 + k.rng.range(0, 7), { tick: idleLook }));
    }
  }
}

export type CueResponse = 'accept' | 'correct' | 'offered' | 'puzzled' | 'decline';

/** Respond to the whistle or to the taught cue, then wait to see what comes of it. */
export class CueGoal extends Activity {
  readonly label: string;
  private respondedAt = 0;
  private trial = false;
  rewarded = false;
  constructor(k: Kinling, readonly cue: CueKind, readonly response: CueResponse, private offered: ActionKind = 'headTilt') {
    super(k);
    this.label = `${cue} cue: ${response}`;
  }
  protected begin(): void {
    const k = this.k;
    const ps = k.world.playerSpot;
    const cam = (): Vec2 => ({ x: ps.x * 1.3, z: ps.z * 1.3 + 1 });
    const rewardedSince = (): boolean => k.brain.lastRewardAt > this.respondedAt && this.respondedAt > 0;
    const mark = new Call(k, () => { this.respondedAt = k.now; this.trial = true; });
    const lookUp = (): void => k.lookAtPlayer(0.5, 2);
    if (this.response === 'accept') {
      const bond = k.learn.data.bond;
      this.phase = 'coming when called';
      this.seq(
        new Do(k, 'perk', { optional: true }),
        new GoTo(k, () => ps, { style: () => (bond > 0.5 && k.needs.values.energy > 0.35 ? 'run' : 'trot'), arrive: 0.6 + (1 - bond) * 1.1 }),
        new Face(k, cam, 0.35),
        new Settle(k, 'sit'),
        mark,
        new Do(k, 'chirp', { optional: true, onContact: () => k.vocal('chirp', 0.6) }),
        new Wait(k, 6.5, { until: rewardedSince, tick: lookUp }),
      );
    } else if (this.response === 'correct') {
      this.phase = 'sitting on cue';
      this.seq(new Face(k, cam, 0.5), new Settle(k, 'sit'), mark, new Wait(k, 6, { until: rewardedSince, tick: lookUp }));
    } else if (this.response === 'offered') {
      this.phase = `trying something (${this.offered})`;
      this.seq(new Face(k, cam, 0.6), new Do(k, this.offered, { optional: true }), new Wait(k, 2.2, { tick: lookUp }));
    } else if (this.response === 'puzzled') {
      this.phase = 'not sure what that meant';
      this.seq(new Call(k, lookUp), new Do(k, 'headTilt', { optional: true }), new Wait(k, 1.2, { tick: lookUp }));
    } else {
      this.phase = 'heard you, would rather not';
      this.seq(new Call(k, lookUp), new Do(k, 'perk', { optional: true }), new Wait(k, 0.6, { tick: lookUp }), new Do(k, 'lookAway', { optional: true }));
    }
  }
  protected override advance(): boolean {
    const k = this.k;
    if (this.trial) {
      this.rewarded = k.brain.lastRewardAt > this.respondedAt;
      k.learn.reinforceCue(this.cue, this.rewarded);
      k.ltm.record({ kind: 'cue', subject: this.cue, x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: this.rewarded ? 0.45 : -0.05, salience: this.rewarded ? 0.4 : 0.15, note: this.rewarded ? `"${this.cue}" earned a reward` : `"${this.cue}" came to nothing` });
      if (this.rewarded) { k.affect.feel(0.1, 0.05); k.vocal('trill', 0.5); }
      this.trial = false;
    }
    return false;
  }
  protected override cleanup(outcome: Outcome): void {
    // an interrupted trial is not counted either way
    void outcome;
  }
}

/** Retreat to the nest and watch from safety until the fright has passed. */
export class SafetyGoal extends Activity {
  readonly label = 'seek safety';
  protected begin(): void {
    const k = this.k;
    const nest = k.learn.data.places[0];
    const threat = { x: k.startle.x, z: k.startle.z };
    this.phase = 'retreating to the nest';
    this.seq(
      new GoTo(k, () => nest, { style: 'trot', arrive: 0.3 }),
      new Face(k, () => threat, 0.4),
      new Settle(k, 'lie'),
      new Wait(k, 40, { until: () => k.affect.wariness < 0.14 && k.needs.values.security > 0.5, tick: () => k.look(threat.x, 0.2, threat.z, 0.5, 1) }),
    );
  }
}

/** Welcome the player back. */
export class GreetGoal extends Activity {
  readonly label = 'greet';
  protected begin(): void {
    const k = this.k;
    const ps = k.world.playerSpot;
    const bond = k.learn.data.bond;
    this.phase = 'running to greet you';
    this.seq(
      new Do(k, 'perk', { optional: true }),
      new GoTo(k, () => ps, { style: bond > 0.4 ? 'run' : 'trot', arrive: 0.6 + (1 - bond) * 0.9 }),
      new Face(k, () => ({ x: ps.x * 1.3, z: ps.z * 1.3 + 1 }), 0.4),
      new Do(k, 'greet', { optional: true, onContact: () => k.vocal('trill', 0.8, 0.2) }),
      new Wait(k, 1.2, { tick: () => k.lookAtPlayer(0.5, 2) }),
    );
  }
  protected override cleanup(outcome: Outcome): void {
    const k = this.k;
    k.world.reunionPending = 0;
    if (outcome !== 'done') return;
    k.affect.feel(0.2, 0.2);
    k.needs.add('social', 0.12);
    k.ltm.record({ kind: 'reunion', subject: 'player', x: k.position.x, z: k.position.z, t: k.now, wall: Date.now(), valence: 0.55, note: 'you came back' });
    k.brain.wantInviteUntil = k.now + 40;
  }
}

/** Step away from handling it does not like, and shake it off. */
export class EvadeGoal extends Activity {
  readonly label = 'move away';
  constructor(k: Kinling, private from: Vec2) {
    super(k);
  }
  protected begin(): void {
    const k = this.k;
    const dx = k.position.x - this.from.x, dz = k.position.z - this.from.z;
    const l = Math.hypot(dx, dz) || 1;
    const p = nearestWalkable(k.position.x + (dx / l) * 1.6, k.position.z + (dz / l) * 1.6);
    this.phase = 'stepping away';
    this.seq(new GoTo(k, () => p, { style: 'walk', arrive: 0.3, timeout: 6 }), new Do(k, 'shake', { optional: true }));
  }
}
