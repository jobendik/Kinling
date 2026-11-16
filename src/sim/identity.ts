/**
 * Who a particular Kinling is. Everything here derives deterministically from
 * a seed, so the same individual is recognisable across sessions: its
 * temperament, its coat, its voice, and the spot where it likes to be stroked.
 */
import { clamp } from '../core/math';
import { Rng } from '../core/rng';

export const TRAIT_KEYS = ['curiosity', 'sociability', 'confidence', 'playfulness', 'persistence', 'sensitivity'] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];
export type Traits = Record<TraitKey, number>;

export type TouchRegion = 'head' | 'ears' | 'chin' | 'back' | 'side' | 'tail' | 'paws';
export const TOUCH_REGIONS: readonly TouchRegion[] = ['head', 'ears', 'chin', 'back', 'side', 'tail', 'paws'];

export interface Look {
  /** Index into the coat palettes. */
  coat: number;
  hueShift: number;
  earScale: number;
  tailScale: number;
  plump: number;
  spotSeed: number;
  eyeHue: number;
  socks: boolean;
  mask: number;
}

export interface Identity {
  seed: number;
  name: string;
  traits: Traits;
  look: Look;
  /** Voice pitch multiplier. */
  voice: number;
  /** Innate touch preferences per body region in [-1, 1]. */
  touchLikes: Record<TouchRegion, number>;
  bornAt: number;
}

export const COAT_NAMES = ['ember', 'dusk', 'moss', 'heather'] as const;

export function makeIdentity(seed: number, name = '', bornAt = 0): Identity {
  const rng = new Rng(seed).fork('identity');
  const trait = (): number => clamp(0.5 + rng.gauss() * 0.2, 0.12, 0.88);
  const traits: Traits = {
    curiosity: trait(),
    sociability: trait(),
    confidence: trait(),
    playfulness: trait(),
    persistence: trait(),
    sensitivity: trait(),
  };
  const look: Look = {
    coat: rng.int(0, COAT_NAMES.length - 1),
    hueShift: rng.range(-0.02, 0.02),
    earScale: rng.range(0.9, 1.14),
    tailScale: rng.range(0.92, 1.1),
    plump: rng.range(0.96, 1.07),
    spotSeed: rng.int(1, 1e6),
    eyeHue: rng.range(0, 1),
    socks: rng.chance(0.5),
    mask: rng.range(0.3, 1),
  };
  const touchLikes = {} as Record<TouchRegion, number>;
  const base: Record<TouchRegion, number> = { head: 0.6, ears: 0.45, chin: 0.55, back: 0.5, side: 0.25, tail: -0.25, paws: -0.35 };
  for (const r of TOUCH_REGIONS) touchLikes[r] = clamp(base[r] + rng.gauss() * 0.22, -1, 1);
  // every individual has one clear favourite
  const fav = rng.pick(['head', 'ears', 'chin', 'back'] as const);
  touchLikes[fav] = clamp(touchLikes[fav] + 0.35, -1, 1);
  return { seed, name, traits, look, voice: rng.range(0.88, 1.16), touchLikes, bornAt };
}

export function favouriteTouch(id: Identity): TouchRegion {
  let best: TouchRegion = 'head';
  for (const r of TOUCH_REGIONS) if (id.touchLikes[r] > id.touchLikes[best]) best = r;
  return best;
}

const NAME_A = ['Em', 'Wil', 'Pip', 'Mo', 'Fen', 'Tam', 'Bri', 'Sor', 'Lu', 'Ha', 'Ni', 'Ro'];
const NAME_B = ['ber', 'lo', 'pin', 'ss', 'nel', 'sin', 'ar', 'rel', 'mi', 'zel', 'bo', 'wan'];
export function suggestName(seed: number): string {
  const rng = new Rng(seed).fork('name');
  return rng.pick(NAME_A) + rng.pick(NAME_B);
}
