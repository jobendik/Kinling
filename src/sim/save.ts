/**
 * Versioned save format. Everything that makes this individual itself and
 * its history is here: identity and seed, traits and their drift, learned
 * values, episodic memory, needs, where things are, and when it was saved.
 * Loading validates and repairs rather than trusting the data.
 */
import { clamp, clamp01 } from '../core/math';
import { Berry } from './entities';
import { makeIdentity, TOUCH_REGIONS, TRAIT_KEYS, type Identity } from './identity';
import { TRAIT_SHIFT_LIMIT, type LearnData } from './learning';
import { MEMORY_CAPACITY, type MemoryData } from './memory';
import { NEED_KEYS, type NeedValues } from './needs';
import { heightAt, isWalkable, nearestWalkable } from './terrain';
import { ACTIVITIES, CURIO_KINDS, type CurioKind, type Posture } from './types';
import type { WildlifeProgress } from './wildlife';
import { BUSH_CAPACITY, World } from './world';

export const SAVE_VERSION = 1;

export interface SaveData {
  version: number;
  savedAt: number;
  identity: Identity;
  time: number;
  dayTime: number;
  needs: NeedValues;
  affect: { valence: number; arousal: number; wariness: number };
  learn: LearnData;
  memory: MemoryData;
  kinling: { x: number; z: number; heading: number; posture: Posture; stats: Record<string, number> };
  world: {
    toys: Record<'ball' | 'rattle', { x: number; y: number; z: number }>;
    wildlife?: WildlifeProgress;
    bushStock: number;
    berries: Array<{ x: number; z: number; fromPlayer: boolean }>;
    curio: { kind: CurioKind; x: number; z: number } | null;
  };
  investigatedAt: Record<string, number>;
}

export function serialize(world: World, now = Date.now()): SaveData {
  const k = world.kinling;
  const toy = (t: { position: { x: number; y: number; z: number } }): { x: number; y: number; z: number } => ({ x: t.position.x, y: t.position.y, z: t.position.z });
  return {
    version: SAVE_VERSION,
    savedAt: now,
    identity: structuredClone(world.identity),
    time: world.time,
    dayTime: world.dayTime,
    needs: { ...k.needs.values },
    affect: { valence: k.affect.valence, arousal: k.affect.arousal, wariness: k.affect.wariness },
    learn: structuredClone(k.learn.data),
    memory: structuredClone(k.ltm.data),
    kinling: { x: k.position.x, z: k.position.z, heading: k.heading, posture: k.posture, stats: { ...k.stats } },
    world: {
      toys: { ball: toy(world.toys.ball), rattle: toy(world.toys.rattle) },
      wildlife: { ...world.wildlife.progress },
      bushStock: world.bushStock,
      berries: world.berries.filter((b) => !b.eaten).map((b) => ({ x: b.position.x, z: b.position.z, fromPlayer: b.fromPlayer })),
      curio: world.curio ? { kind: world.curio.kind, x: world.curio.position.x, z: world.curio.position.z } : null,
    },
    investigatedAt: { ...k.brain.investigatedAt },
  };
}

const num = (v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Older formats are upgraded step by step. (v1 is the first public format.) */
function migrate(raw: Record<string, unknown>): Record<string, unknown> | null {
  const v = raw.version;
  if (v === SAVE_VERSION) return raw;
  return null;
}

/**
 * Validate untrusted data into a usable save, repairing what can be repaired.
 * Returns null when it is not a Kinling save at all.
 */
export function parseSave(input: unknown): SaveData | null {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch { return null; }
  }
  const m = migrate(obj(raw));
  if (!m) return null;
  const idRaw = obj(m.identity);
  const seed = num(idRaw.seed, NaN);
  if (!Number.isFinite(seed)) return null;
  // the individual is re-derived from its seed, so a damaged identity heals itself
  const identity = makeIdentity(seed, typeof idRaw.name === 'string' ? idRaw.name.slice(0, 24) : '', num(idRaw.bornAt, Date.now()));

  const defaults = serialize(new World(identity), 0);
  const needsRaw = obj(m.needs);
  const needs = {} as NeedValues;
  for (const key of NEED_KEYS) needs[key] = num(needsRaw[key], defaults.needs[key], 0, 1);
  const a = obj(m.affect);
  const affect = { valence: num(a.valence, 0.1, -1, 1), arousal: num(a.arousal, 0.4, 0, 1), wariness: num(a.wariness, 0, 0, 1) };

  const L = obj(m.learn);
  const learn = defaults.learn;
  for (const act of ACTIVITIES) {
    learn.affinity[act] = num(obj(L.affinity)[act], learn.affinity[act], 0, 1);
    learn.plays[act] = num(obj(L.plays)[act], 0, 0, 1e7);
  }
  for (const [key, v] of Object.entries(obj(L.habituation))) {
    const h = obj(v);
    learn.habituation[key.slice(0, 24)] = { h: num(h.h, 0, 0, 1), n: num(h.n, 0, 0, 1e7), lastAt: num(h.lastAt, 0) };
  }
  for (const [key, v] of Object.entries(obj(L.familiarity))) learn.familiarity[key.slice(0, 24)] = num(v, 0, 0, 1);
  for (const cue of ['come', 'sit', 'spin'] as const) {
    const c = obj(obj(L.cues)[cue]);
    learn.cues[cue] = { strength: num(c.strength, learn.cues[cue].strength, 0, 1), trials: num(c.trials, 0, 0, 1e7), rewards: num(c.rewards, 0, 0, 1e7) };
  }
  learn.bond = num(L.bond, learn.bond, 0, 1);
  if (Array.isArray(L.places)) {
    const innate = learn.places.filter((p) => p.innate);
    const extra = [];
    for (const p of L.places.slice(0, 12)) {
      const o = obj(p);
      const label = typeof o.label === 'string' ? o.label.slice(0, 24) : 'spot';
      const base = innate.find((i) => i.label === label);
      if (base) { base.comfort = num(o.comfort, base.comfort, 0, 1); base.visits = num(o.visits, 0, 0, 1e7); }
      else if (extra.length < 5) extra.push({ label, x: num(o.x, 0, -9, 9), z: num(o.z, 0, -9, 9), comfort: num(o.comfort, 0.4, 0, 1), visits: num(o.visits, 0, 0, 1e7), innate: false });
    }
    learn.places = [...innate, ...extra];
  }
  for (const r of TOUCH_REGIONS) learn.touch[r] = num(obj(L.touch)[r], 0, -0.35, 0.35);
  for (const t of TRAIT_KEYS) learn.traitShift[t] = num(obj(L.traitShift)[t], 0, -TRAIT_SHIFT_LIMIT, TRAIT_SHIFT_LIMIT);
  if (Array.isArray(L.explored) && L.explored.length === learn.explored.length) learn.explored = L.explored.map((v) => num(v, 0, 0, 1));

  const M = obj(m.memory);
  const memory: MemoryData = { episodes: [], whereabouts: {} };
  if (Array.isArray(M.episodes)) {
    for (const e of M.episodes.slice(-MEMORY_CAPACITY)) {
      const o = obj(e);
      if (typeof o.kind !== 'string') continue;
      memory.episodes.push({
        kind: o.kind as MemoryData['episodes'][number]['kind'],
        subject: typeof o.subject === 'string' ? o.subject.slice(0, 32) : '',
        x: num(o.x, 0, -12, 12), z: num(o.z, 0, -12, 12), t: num(o.t, 0), wall: num(o.wall, 0),
        valence: num(o.valence, 0, -1, 1), salience: num(o.salience, 0.2, 0, 1), count: num(o.count, 1, 1, 1e6),
        note: typeof o.note === 'string' ? o.note.slice(0, 120) : '',
      });
    }
  }
  for (const [key, v] of Object.entries(obj(M.whereabouts))) {
    const o = obj(v);
    memory.whereabouts[key.slice(0, 24)] = { x: num(o.x, 0, -12, 12), z: num(o.z, 0, -12, 12), t: num(o.t, 0) };
  }

  const K = obj(m.kinling);
  const posture = (['stand', 'sit', 'lie', 'sleep'] as const).includes(K.posture as Posture) ? (K.posture as Posture) : 'stand';
  let kx = num(K.x, defaults.kinling.x, -9, 9), kz = num(K.z, defaults.kinling.z, -9, 9);
  if (!isWalkable(kx, kz)) ({ x: kx, z: kz } = nearestWalkable(kx, kz));
  const stats: Record<string, number> = {};
  for (const key of Object.keys(defaults.kinling.stats)) stats[key] = num(obj(K.stats)[key], 0, 0, 1e9);

  const W = obj(m.world);
  const v = obj(W.wildlife);
  const wildlife = { meals: Math.floor(num(v.meals, 0, 0, 1e7)), replies: Math.floor(num(v.replies, 0, 0, 1e7)), best: Math.floor(num(v.best, 0, 0, 6)) };
  const toys = defaults.world.toys;
  for (const kind of ['ball', 'rattle'] as const) {
    const t = obj(obj(W.toys)[kind]);
    let x = num(t.x, toys[kind].x, -9, 9), z = num(t.z, toys[kind].z, -9, 9);
    if (!isWalkable(x, z, 0.1)) ({ x, z } = nearestWalkable(x, z, 0.1));
    toys[kind] = { x, y: heightAt(x, z) + 0.085, z };
  }
  const berries: SaveData['world']['berries'] = [];
  if (Array.isArray(W.berries)) for (const b of W.berries.slice(0, 8)) { const o = obj(b); berries.push({ x: num(o.x, 0, -9, 9), z: num(o.z, 0, -9, 9), fromPlayer: o.fromPlayer === true }); }
  const C = obj(W.curio);
  const curio = CURIO_KINDS.includes(C.kind as CurioKind) ? { kind: C.kind as CurioKind, x: num(C.x, 0, -9, 9), z: num(C.z, 0, -9, 9) } : null;

  const investigatedAt: Record<string, number> = {};
  for (const [key, v] of Object.entries(obj(m.investigatedAt))) investigatedAt[key.slice(0, 24)] = num(v, -1e9);

  return {
    version: SAVE_VERSION,
    savedAt: num(m.savedAt, Date.now(), 0),
    identity,
    time: num(m.time, 0, 0, 1e12),
    dayTime: num(m.dayTime, 0.6, 0, 0.99999),
    needs, affect, learn, memory,
    kinling: { x: kx, z: kz, heading: num(K.heading, 0, -1e3, 1e3), posture, stats },
    world: { toys, wildlife, bushStock: Math.round(num(W.bushStock, 2, 0, BUSH_CAPACITY)), berries, curio },
    investigatedAt,
  };
}

/** Rebuild a world from a (validated) save. Body state always restores to something valid. */
export function restore(data: SaveData): World {
  const world = new World(data.identity);
  const k = world.kinling;
  Object.assign(world.wildlife.progress, data.world.wildlife);
  world.time = data.time;
  world.dayTime = data.dayTime;
  Object.assign(k.needs.values, data.needs);
  Object.assign(k.affect, data.affect);
  k.learn.data = structuredClone(data.learn);
  k.ltm.data = structuredClone(data.memory);
  k.traits = k.learn.traits();
  k.brain.refreshBias();
  k.brain.investigatedAt = { ...data.investigatedAt };
  Object.assign(k.stats, data.kinling.stats);
  k.place(data.kinling.x, data.kinling.z, data.kinling.heading);
  for (const kind of ['ball', 'rattle'] as const) {
    const t = data.world.toys[kind];
    world.toys[kind].position.set(t.x, heightAt(t.x, t.z) + world.toys[kind].radius, t.z);
  }
  world.bushStock = data.world.bushStock;
  for (const b of data.world.berries) {
    const berry = new Berry(world, b.x, b.z, b.fromPlayer, world.time - 200, 0);
    world.berries.push(berry);
    world.manager.add(berry);
  }
  if (data.world.curio) world.placeCurio(data.world.curio.kind, data.world.curio.x, data.world.curio.z);
  // it remembers its toys' whereabouts and its home, so seed short-term senses from long-term memory
  if (data.kinling.posture === 'sleep') { k.settle('lie'); k.postureT = 5; k.fallAsleep(); k.sleepDepth = 0.8; }
  else if (data.kinling.posture === 'lie' || data.kinling.posture === 'sit') { k.settle(data.kinling.posture); k.postureT = 5; }
  world.playerActiveAt = -1e9;
  return world;
}

export function clampTime(v: number): number {
  return clamp01(v);
}
