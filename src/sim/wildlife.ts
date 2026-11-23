import { Rng } from '../core/rng';
import { heightAt, isWalkable, nearestWalkable, POND, WATER_Y } from './terrain';
import type { World } from './world';

export type Species = 'robin' | 'frog';
export type Subject = Species | 'kinling';
export interface Spot { x: number; y: number; z: number }
export const PAD_NAMES = ['Amber', 'Rose', 'Pearl'] as const;
export const PADS = [
  { x: POND.x - 0.56, y: WATER_Y + 0.035, z: POND.z },
  { x: POND.x, y: WATER_Y + 0.035, z: POND.z - 0.43 },
  { x: POND.x + 0.54, y: WATER_Y + 0.035, z: POND.z + 0.09 },
];
const ground = (x: number, z: number): Spot => ({ x, z, y: heightAt(x, z) });
const PERCH = { ...ground(-1.56, -3.06), y: heightAt(-1.56, -3.06) + 0.57 };
const SEEDS = [ground(-0.78, -2.72), ground(-0.40, -2.94), ground(-0.12, -3.18)];
export interface WildlifeProgress { meals: number; replies: number; best: number }
interface Trip { from: Spot; to: Spot; elapsed: number; duration: number; lift: number }

class Animal {
  trip: Trip | null = null;
  heading = 0;
  lift = 0;
  constructor(readonly position: Spot) {}
  move(to: Spot, duration: number, lift: number): void {
    this.trip = { from: { ...this.position }, to, elapsed: 0, duration, lift };
    this.heading = Math.atan2(to.x - this.position.x, to.z - this.position.z);
  }
  step(dt: number): boolean {
    const trip = this.trip;
    if (!trip) return false;
    trip.elapsed += dt;
    const t = Math.min(1, trip.elapsed / trip.duration), blend = t * t * (3 - 2 * t);
    this.lift = Math.sin(Math.PI * t);
    this.position.x = trip.from.x + (trip.to.x - trip.from.x) * blend;
    this.position.z = trip.from.z + (trip.to.z - trip.from.z) * blend;
    this.position.y = trip.from.y + (trip.to.y - trip.from.y) * blend + this.lift * trip.lift;
    if (t < 1) return false;
    this.trip = null;
    this.lift = 0;
    return true;
  }
}

/** Visitors have their own clock and random stream so they never perturb the kinling's decisions. */
export class Wildlife {
  readonly progress: WildlifeProgress = { meals: 0, replies: 0, best: 0 };
  readonly robin = new Animal({ ...PERCH });
  readonly frog = new Animal({ ...PADS[0] });
  seeds: Spot | null = null;
  robinMode: 'perched' | 'watching' | 'foraging' | 'pecking' | 'returning' | 'singing' | 'replying' | 'visiting' = 'perched';
  frogMode: 'resting' | 'showing' | 'answer' | 'miss' | 'won' = 'resting';
  sequence: number[] = [];
  cursor = 0;
  pad = 0;
  flash = -1;
  private flashLeft = 0;
  private robinTimer = 6;
  private frogTimer = 8;
  private fed = false;
  private rng: Rng;

  constructor(private world: World) { this.rng = world.rng.fork('wildlife'); }

  private call(species: Species): void {
    const p = this[species].position;
    this.world.events.emit('wildlifeCall', { species, x: p.x, z: p.z });
    const k = this.world.kinling;
    if (!k.asleep && k.distanceTo(p.x, p.z) < 2.3) k.look(p.x, p.y + 0.18, p.z, 1, 1);
  }

  scatter(at?: { x: number; z: number }): void {
    if (this.seeds || this.robinMode === 'pecking' || this.robinMode === 'visiting') return;
    this.seeds = at && isWalkable(at.x, at.z, .12) && Math.hypot(at.x - PERCH.x, at.z - PERCH.z) < 3
      ? ground(at.x, at.z) : SEEDS[this.progress.meals % SEEDS.length];
    this.robinMode = 'watching';
    this.robinTimer = Math.max(0.35, 1.6 - this.progress.meals * 0.25);
  }

  whistle(): void {
    if (this.robinMode !== 'perched') return;
    this.robinMode = 'singing';
    this.robinTimer = 0.7;
  }

  startChorus(): void {
    if (this.frog.trip || this.frogMode === 'showing') return;
    if (this.frogMode !== 'answer' && this.frogMode !== 'miss') {
      const length = Math.min(6, Math.max(2, this.progress.best + 1));
      this.sequence = [];
      let from = this.pad;
      for (let i = 0; i < length; i++) {
        from = (from + this.rng.int(1, 2)) % PADS.length;
        this.sequence.push(from);
      }
    }
    this.cursor = 0;
    this.frogTimer = 0.55;
    this.frogMode = 'showing';
  }

  leaveChorus(): void {
    if (this.frogMode === 'answer' || this.frogMode === 'showing') {
      this.frogMode = 'resting';
      this.frogTimer = 4;
      this.flash = -1;
    }
  }

  choosePad(index: number): void {
    if (this.frogMode !== 'answer' || this.frog.trip || !Number.isInteger(index) || !PADS[index]) return;
    if (index !== this.sequence[this.cursor]) {
      this.frogMode = 'miss';
      this.flashPad(this.sequence[this.cursor]);
      this.frogTimer = 5;
      return;
    }
    this.hop(index);
    this.cursor++;
    if (this.cursor === this.sequence.length) {
      this.progress.best = Math.max(this.progress.best, this.cursor);
      this.frogMode = 'won';
      this.frogTimer = 6;
    }
  }

  private flashPad(index: number): void { this.flash = index; this.flashLeft = 0.65; }
  private hop(index: number): void {
    this.pad = index;
    this.flashPad(index);
    this.frog.move(PADS[index], 0.48, 0.29);
  }

  step(dt: number): void {
    this.robin.step(dt);
    if (this.frog.step(dt)) {
      const p = this.frog.position;
      this.world.events.emit('ripple', { x: p.x, z: p.z, strength: 0.48 });
      this.call('frog');
    }
    if ((this.flashLeft -= dt) <= 0) this.flash = -1;
    if (!this.robin.trip && (this.robinTimer -= dt) <= 0) this.nextRobin();
    if (!this.frog.trip && this.frogMode !== 'answer' && (this.frogTimer -= dt) <= 0) this.nextFrog();
  }

  private nextRobin(): void {
    const bird = this.robin;
    switch (this.robinMode) {
      case 'singing':
        this.call('robin');
        this.progress.replies++;
        this.robinMode = 'replying';
        this.robinTimer = 2;
        break;
      case 'replying':
        this.robinMode = 'perched';
        this.robinTimer = 3;
        break;
      case 'perched':
        if (this.world.night > 0.6) { this.robinTimer = 8; break; }
        this.call('robin');
        this.robinMode = 'foraging';
        bird.move(this.rng.pick(SEEDS), 1.05, 0.42);
        break;
      case 'watching':
        this.robinMode = 'foraging';
        bird.move(this.seeds!, 1.05, 0.42);
        break;
      case 'foraging':
        this.fed = !!this.seeds;
        this.robinMode = 'pecking';
        this.robinTimer = 1.3;
        break;
      case 'pecking':
        if (this.fed) {
          this.progress.meals++;
          this.seeds = null;
          const k = this.world.kinling;
          if (this.progress.meals >= 3 && !k.asleep) {
            this.fed = false;
            this.robinMode = 'visiting';
            const friend = nearestWalkable(k.position.x + .48, k.position.z, .1);
            bird.move(ground(friend.x, friend.z), 1.1, .65);
            this.robinTimer = 1.5;
            break;
          }
        }
        this.fed = false;
        this.robinMode = 'returning';
        bird.move(PERCH, 0.85, 0.33);
        break;
      case 'visiting': {
        this.call('robin');
        const k = this.world.kinling;
        if (!k.asleep && k.distanceTo(bird.position.x, bird.position.z) < 1.8 && k.affect.wariness < .5) {
          k.vocal('trill', .5);
          k.needs.add('social', .035);
        }
        this.robinMode = 'returning';
        bird.move(PERCH, 1.3, .65);
        break;
      }
      case 'returning':
        this.robinMode = 'perched';
        this.robinTimer = this.rng.range(5, 14);
        break;
    }
  }

  private nextFrog(): void {
    if (this.frogMode === 'showing') {
      if (this.cursor === this.sequence.length) {
        this.frogMode = 'answer';
        this.cursor = 0;
      } else {
        this.hop(this.sequence[this.cursor++]);
        this.frogTimer = 0.65;
      }
      return;
    }
    this.frogMode = 'resting';
    this.hop((this.pad + this.rng.int(1, 2)) % PADS.length);
    this.frogTimer = this.rng.range(6, 14) / (1 + this.world.night);
  }
}
