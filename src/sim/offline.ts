/**
 * What happens between visits. Nothing runs while the page is closed or
 * hidden; on return we apply one bounded, plausible estimate of how the time
 * passed (it rested, drank, foraged, got a little bored and missed company)
 * instead of replaying missed frames. Odd clocks are handled: negative or
 * non-finite gaps count as no time at all, and long gaps are capped.
 */
import { clamp01 } from '../core/math';
import { Rng } from '../core/rng';
import { NEST } from './terrain';
import { BUSH_CAPACITY, DAY_LENGTH_S, nightFactor, World } from './world';

/** At most this much absence changes the creature's state. */
export const ABSENCE_CAP_S = 12 * 3600;
/** Shorter gaps than this are treated as a continuous session. */
export const ABSENCE_MIN_S = 45;

export interface AbsenceReport {
  elapsed: number;
  credited: number;
  applied: boolean;
  asleep: boolean;
  summary: string;
}

const relax = (value: number, toward: number, tau: number, t: number): number => toward + (value - toward) * Math.exp(-t / tau);

export function describeGap(seconds: number): string {
  if (seconds < 90) return 'a moment';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 36 * 3600) { const h = Math.round(seconds / 3600); return h === 1 ? 'an hour' : `${h} hours`; }
  const d = Math.round(seconds / 86400);
  return d === 1 ? 'a day' : `${d} days`;
}

export function applyAbsence(world: World, elapsedSeconds: number): AbsenceReport {
  const elapsed = Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 ? elapsedSeconds : 0;
  const k = world.kinling;
  if (elapsed < ABSENCE_MIN_S) return { elapsed, credited: 0, applied: false, asleep: k.asleep, summary: '' };
  const t = Math.min(elapsed, ABSENCE_CAP_S);

  world.time += t;
  // the sky keeps its own time
  world.dayTime = (world.dayTime + (elapsed % (DAY_LENGTH_S * 0.8)) / (DAY_LENGTH_S * 0.8)) % 1;

  const v = k.needs.values;
  const before = { ...v };
  v.energy = relax(v.energy, 0.92, 20 * 60, t); // it slept when it was tired
  v.hydration = relax(v.hydration, 0.78, 30 * 60, t); // the pond is always there
  v.nourishment = relax(v.nourishment, 0.55, 40 * 60, t); // foraging keeps hunger at bay, no more
  v.stimulation = relax(v.stimulation, 0.3, 45 * 60, t); // quiet without a playmate
  v.social = relax(v.social, 0.14, 60 * 60, t); // it has missed company
  v.security = relax(v.security, 0.5 + 0.42 * k.traits.confidence, 10 * 60, t);
  for (const key of Object.keys(v) as Array<keyof typeof v>) v[key] = clamp01(v[key]);
  k.affect.valence = relax(k.affect.valence, 0.05, 15 * 60, t);
  k.affect.arousal = relax(k.affect.arousal, 0.3, 5 * 60, t);
  k.affect.wariness = relax(k.affect.wariness, 0, 3 * 60, t);
  k.affect.interest = 0;

  k.ltm.decay(t);
  k.learn.fadeExplored(t);
  // treats left on the ground were found and eaten; the bush has regrown
  let found = 0;
  for (const b of [...world.berries]) if (t > 8 * 60) { world.removeBerry(b); found++; }
  world.berries = world.berries.filter((b) => !b.eaten);
  if (t > 6 * 60) world.bushStock = BUSH_CAPACITY - (before.nourishment < 0.5 ? 1 : 0);
  if (k.carrying) k.release(0);

  // where it is now: at its preferred resting place, asleep if that is likely
  const rng = new Rng((world.identity.seed ^ Math.floor(elapsed)) >>> 0);
  const night = nightFactor(world.dayTime);
  let asleep = k.asleep;
  if (t > 3 * 60) {
    const place = k.learn.restPlace(k.position.x, k.position.z, night);
    k.brain.interrupt('away');
    k.brain.resume();
    if (k.mode !== 'FREE') { k.rise(); k.riseT = 0; }
    k.place(place.x + rng.range(-0.1, 0.1), place.z + rng.range(-0.1, 0.1), Math.atan2(-place.x, -place.z) + rng.range(-0.6, 0.6));
    asleep = rng.chance(0.25 + 0.7 * night);
    k.settle('lie');
    k.postureT = 10;
    if (asleep) { k.fallAsleep(); k.sleepDepth = 0.7; v.energy = Math.min(v.energy, 0.8); }
    void NEST;
  }
  world.reunionPending = elapsed;
  world.playerActiveAt = world.time;

  const gap = describeGap(elapsed);
  const did = asleep ? 'is asleep' : t > 3 * 60 ? 'has been resting' : 'has been pottering about';
  const extra = found > 0 ? ' and found the berries you left' : '';
  return {
    elapsed, credited: t, applied: true, asleep,
    summary: `You were away for ${gap}. ${world.identity.name || 'Your kinling'} ${did}${extra}.`,
  };
}
