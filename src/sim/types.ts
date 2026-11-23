/** Shared simulation vocabulary. Nothing here depends on rendering. */
import type { TouchRegion } from './identity';

export type ToyKind = 'ball' | 'rattle';
export type ActivityId = 'ball' | 'rattle' | 'wisp';
export const ACTIVITIES: readonly ActivityId[] = ['ball', 'rattle', 'wisp'];
export type CurioKind = 'hummer' | 'spinner' | 'shell';
export const CURIO_KINDS: readonly CurioKind[] = ['hummer', 'spinner', 'shell'];
export type CueKind = 'come' | 'sit' | 'spin';

export type Posture = 'stand' | 'sit' | 'lie' | 'sleep';
export type MoveStyle = 'amble' | 'walk' | 'trot' | 'run' | 'sneak' | 'cautious' | 'tired';
export type BodyMode = 'FREE' | 'SETTLED' | 'INTERACT' | 'ASLEEP' | 'STARTLED';

export type ActionKind =
  | 'eat' | 'drink' | 'sniff' | 'pounce' | 'pickup' | 'drop' | 'bat' | 'gnaw'
  | 'playBow' | 'stretch' | 'shake' | 'groom' | 'yawn' | 'headTilt' | 'knead'
  | 'chirp' | 'greet' | 'wiggle' | 'pawAt' | 'lookAway' | 'perk' | 'nuzzle' | 'spin';

export type VocalKind = 'chirp' | 'trill' | 'purr' | 'squeak' | 'huff' | 'whine' | 'yawn' | 'coo' | 'sniff' | 'munch' | 'lap';

export interface Vec2 { x: number; z: number }

export interface SoundEvent {
  kind: 'whistle' | 'cue' | 'chime' | 'bounce' | 'rattle' | 'plop' | 'splash' | 'tap';
  x: number;
  z: number;
  /** 0..1 */
  loud: number;
  sourceId?: string;
  cue?: CueKind;
}

/** Events the simulation publishes for presentation (animation accents, audio, UI). */
export interface SimEvents {
  wildlifeCall: { species: 'robin' | 'frog'; x: number; z: number };
  vocal: { kind: VocalKind; intensity: number };
  sound: SoundEvent;
  ripple: { x: number; z: number; strength: number };
  rustle: { x: number; z: number; strength: number };
  toyImpact: { kind: ToyKind | 'berry'; speed: number; x: number; z: number; surface: 'ground' | 'rock' | 'water' };
  berry: { type: 'drop' | 'eaten' | 'regrow'; x: number; z: number };
  curio: { type: 'placed' | 'removed' | 'chime'; kind: CurioKind; x: number; z: number };
  goal: { name: string; reason: string };
  mode: { mode: BodyMode; prev: BodyMode };
  action: { kind: ActionKind; phase: 'start' | 'contact' | 'end' | 'cancel' };
  learn: { text: string; key: string; value: number };
  memory: { text: string };
  cue: { kind: CueKind; response: 'accept' | 'postpone' | 'decline' | 'correct' | 'offered' | 'puzzled' | 'unheard'; detail?: string };
  touch: { region: TouchRegion; liked: number; kind: 'stroke' | 'tap' };
  hint: { id: string; text: string };
  wisp: { type: 'caught' | 'escaped' };
  pickup: { toy: ToyKind };
  dropToy: { toy: ToyKind };
}

export const MSG = {
  TOUCH: 'touch',
  SOUND: 'sound',
  CUE: 'cue',
} as const;
