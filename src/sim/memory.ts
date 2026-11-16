/**
 * Long-term episodic memory, beyond Yuka's short-term MemorySystem (which
 * only tracks what was sensed in the last half minute).
 *
 * Meaningful experiences are stored as episodes with place, outcome and
 * salience. Repeats of the same kind of experience in the same area
 * consolidate into one stronger episode instead of piling up; salience
 * decays (emotional episodes more slowly) and the store is bounded.
 */
import { clamp, clamp01 } from '../core/math';

export type EpisodeKind =
  | 'play' | 'fed' | 'pet' | 'startle' | 'discover' | 'lostToy' | 'nap' | 'reunion'
  | 'cue' | 'ignored' | 'foundToy' | 'drank' | 'ate' | 'roughTouch' | 'gift';

export interface Episode {
  kind: EpisodeKind;
  subject: string;
  x: number;
  z: number;
  /** Simulation clock, seconds lived. */
  t: number;
  /** Wall clock, ms since epoch. */
  wall: number;
  valence: number;
  salience: number;
  count: number;
  note: string;
}

export interface MemoryData {
  episodes: Episode[];
  whereabouts: Record<string, { x: number; z: number; t: number }>;
}

export const MEMORY_CAPACITY = 64;
const MERGE_RADIUS = 1.6;
const MERGE_WINDOW_S = 900;

export class LongTermMemory {
  data: MemoryData = { episodes: [], whereabouts: {} };
  onRecord: ((e: Episode, merged: boolean) => void) | null = null;

  record(e: Omit<Episode, 'count' | 'salience'> & { salience?: number }): Episode {
    const salience = clamp01(e.salience ?? 0.3 + 0.5 * Math.abs(e.valence));
    for (const old of this.data.episodes) {
      if (old.kind !== e.kind || old.subject !== e.subject) continue;
      if (e.t - old.t > MERGE_WINDOW_S) continue;
      if (Math.hypot(old.x - e.x, old.z - e.z) > MERGE_RADIUS) continue;
      // consolidate: one stronger memory instead of many thin ones
      old.count++;
      old.valence = clamp(old.valence + (e.valence - old.valence) / Math.min(old.count, 5), -1, 1);
      old.salience = clamp01(Math.max(old.salience, salience) + 0.07);
      old.x += (e.x - old.x) * 0.3;
      old.z += (e.z - old.z) * 0.3;
      old.t = e.t;
      old.wall = e.wall;
      old.note = e.note;
      this.onRecord?.(old, true);
      return old;
    }
    const ep: Episode = { ...e, salience, count: 1 };
    this.data.episodes.push(ep);
    if (this.data.episodes.length > MEMORY_CAPACITY) this.evict();
    this.onRecord?.(ep, false);
    return ep;
  }

  private evict(): void {
    let worst = 0;
    for (let i = 1; i < this.data.episodes.length; i++) if (this.data.episodes[i].salience < this.data.episodes[worst].salience) worst = i;
    this.data.episodes.splice(worst, 1);
  }

  /** Forgetting. Strongly felt and often-repeated episodes fade more slowly. */
  decay(dt: number): void {
    for (const e of this.data.episodes) {
      const tau = 2400 * (1 + 3 * Math.abs(e.valence)) * (1 + 0.5 * Math.log2(e.count + 1));
      e.salience *= Math.exp(-dt / tau);
    }
  }

  /** Sleep consolidation: drop what has faded, firm up what mattered. Bounded. */
  consolidate(): { dropped: number; kept: number } {
    const before = this.data.episodes.length;
    this.data.episodes = this.data.episodes.filter((e) => e.salience >= 0.06);
    const top = [...this.data.episodes].sort((a, b) => b.salience - a.salience).slice(0, 6);
    for (const e of top) e.salience = clamp01(e.salience + 0.04);
    return { dropped: before - this.data.episodes.length, kept: this.data.episodes.length };
  }

  recall(kind: EpisodeKind, subject?: string): Episode | null {
    let best: Episode | null = null;
    for (const e of this.data.episodes) {
      if (e.kind !== kind) continue;
      if (subject !== undefined && e.subject !== subject) continue;
      if (!best || e.salience > best.salience) best = e;
    }
    return best;
  }

  /** Net remembered feeling about a subject, weighted by salience. */
  feelingAbout(subject: string): number {
    let s = 0, w = 0;
    for (const e of this.data.episodes) {
      if (e.subject !== subject) continue;
      s += e.valence * e.salience;
      w += e.salience;
    }
    return w > 0 ? s / w : 0;
  }

  recent(n: number): Episode[] {
    return [...this.data.episodes].sort((a, b) => b.t - a.t).slice(0, n);
  }

  // ── where things were last seen (survives reloads) ─────────────
  sawAt(id: string, x: number, z: number, t: number): void {
    this.data.whereabouts[id] = { x, z, t };
  }
  lastSeen(id: string): { x: number; z: number; t: number } | null {
    return this.data.whereabouts[id] ?? null;
  }
}
