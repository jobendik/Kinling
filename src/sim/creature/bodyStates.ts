/**
 * The body state machine (Yuka StateMachine). It owns *how the body is
 * currently engaged* — free to move, settled, mid-interaction, asleep, or
 * recovering from a fright — sequences action phases, and is where sensory
 * telegrams (touch, sound, cue) land. Goals ask for postures and actions;
 * this machine decides when they can happen and cleans up when interrupted.
 *
 * Think/goals decide *what to do*; this decides *what the body can do now*.
 */
import { State, StateMachine, Telegram } from 'yuka';
import { clamp, clamp01 } from '../../core/math';
import type { TouchRegion } from '../identity';
import { MSG, type BodyMode, type CueKind, type SoundEvent } from '../types';
import type { Kinling } from './Kinling';

type HeardSound = SoundEvent & { distance: number };
interface TouchData { region: TouchRegion; kind: 'stroke' | 'tap'; x: number; y: number; z: number }

function setMode(k: Kinling, mode: BodyMode): void {
  const prev = k.mode;
  k.mode = mode;
  if (prev !== mode) k.world.events.emit('mode', { mode, prev });
}

const SOUND_BASE: Record<SoundEvent['kind'], number> = {
  whistle: 0.22, cue: 0.18, chime: 0.9, bounce: 0.3, rattle: 0.32, plop: 0.3, splash: 0.36, tap: 0.5,
};

export function beginStartle(k: Kinling, strength: number, x: number, z: number, kind: string): void {
  if (k.mode === 'STARTLED') {
    k.startle.strength = Math.max(k.startle.strength, strength);
    return;
  }
  k.startle.strength = clamp01(strength);
  k.startle.x = x; k.startle.z = z; k.startle.kind = kind;
  k.body.changeTo('STARTLED');
}

function wake(k: Kinling, how: 'rested' | 'touch' | 'noise' | 'need'): void {
  k.brain.wokeBy = how;
  k.rise();
}

function handleSound(k: Kinling, d: HeardSound): void {
  k.senses.hear(d);
  const t = k.traits;
  const hab = k.learn.habituation(d.kind, k.now);
  const prox = clamp01(1.25 - d.distance / (4 + 10 * d.loud));
  const expected = k.playing && (d.kind === 'bounce' || d.kind === 'rattle' || d.kind === 'splash') ? 0.3 : 1;
  const surprise =
    SOUND_BASE[d.kind] * (0.5 + d.loud) * prox * (1 - hab) * (0.55 + 0.9 * t.sensitivity) * (1.25 - 0.5 * t.confidence) * expected * (k.asleep ? 1.15 : 1);

  if (k.asleep) {
    if (surprise > 0.3) {
      k.sleepDepth = 0;
      wake(k, 'noise');
      if (surprise > 0.42) beginStartle(k, surprise, d.x, d.z, d.kind);
    } else k.sleepDepth = Math.max(0, k.sleepDepth - surprise);
    return;
  }
  if (surprise > 0.06) {
    k.look(d.x, 0.12, d.z, 1 + surprise * 2, 2);
    k.alert = Math.max(k.alert, clamp01(surprise * 1.8));
    k.affect.interest = clamp01(k.affect.interest + 0.15 + surprise * 0.3);
  }
  if (surprise > 0.42) beginStartle(k, surprise, d.x, d.z, d.kind);
  else if (surprise > 0.1 && k.now - (k.brain.lastHabituated[d.kind] ?? -1e9) > 4) {
    // noticed, and nothing bad came of it
    k.brain.lastHabituated[d.kind] = k.now;
    k.learn.habituate(d.kind, k.now);
  }
}

function handleTouch(k: Kinling, d: TouchData): void {
  const now = k.now;
  const t = k.touch;
  const liking = k.learn.touchLiking(d.region);
  const bond = k.learn.data.bond;
  const newBout = now - t.at > 2.5;
  if (newBout) { t.strokes = 0; t.boutStart = now; t.placeNoted = false; }
  t.region = d.region; t.x = d.x; t.y = d.y; t.z = d.z; t.at = now; t.strokes++;
  k.world.events.emit('touch', { region: d.region, liked: liking, kind: d.kind });

  if (k.asleep) {
    if (d.kind === 'tap') {
      k.sleepDepth -= 0.6;
      if (k.sleepDepth < 0.3) {
        wake(k, 'touch');
        k.vocal('huff', 0.5);
        k.learn.adjustBond(-0.012, 'poked awake');
        k.affect.feel(-0.12, 0.2, 0.1);
      }
    } else {
      t.liked = Math.max(0.2, liking);
      k.sleepDepth -= 0.07;
      if (t.strokes % 6 === 2) k.vocal('purr', 0.25);
      k.needs.add('social', 0.012);
      if (t.strokes > 9 && k.needs.values.energy > 0.5) wake(k, 'touch');
    }
    return;
  }
  if (k.mode === 'STARTLED') { k.affect.feel(0, 0, 0.05); return; }

  if (d.kind === 'tap') {
    const hab = k.learn.habituation('tap', now);
    const surprise = 0.55 * (1 - hab) * (0.5 + k.traits.sensitivity) * (1.25 - bond);
    k.look(d.x, d.y, d.z, 1.2, 3);
    if (surprise > 0.42) beginStartle(k, surprise, d.x, d.z, 'tap');
    else {
      k.alert = 1;
      k.learn.habituate('tap', now);
      k.brain.onPoke();
    }
    return;
  }

  // a stroke
  const trust = bond + 0.3 * k.traits.confidence + 0.2 * k.traits.sociability + 0.25 * k.learn.familiarity('hand') - 0.5 * k.affect.wariness;
  if (newBout && trust < 0.42 && k.rng.chance(clamp01(0.75 - trust))) {
    // not sure about the hand yet: lean away and watch it
    const dx = k.position.x - d.x, dz = k.position.z - d.z;
    const l = Math.hypot(dx, dz) || 1;
    k.recoil.x += (dx / l) * 1.1; k.recoil.z += (dz / l) * 1.1;
    k.look(d.x, d.y, d.z, 1.6, 3);
    k.alert = 1;
    t.liked = -0.4;
    k.vocal('huff', 0.3);
    k.learn.familiarise('hand', 0.2);
    k.affect.feel(0, 0.1, 0.08);
    return;
  }
  t.liked = liking;
  k.brain.onReward('touch');
  if (liking >= 0) {
    k.affect.feel(0.03 * (0.4 + liking), -0.008, -0.03);
    k.needs.add('social', 0.028 * (0.5 + liking));
    k.needs.add('security', 0.008);
    k.learn.adjustBond(0.0028 * (0.5 + liking), 'gentle stroking');
    if (t.strokes === 1) { k.stats.pets++; k.learn.familiarise('hand', 0.12); }
    if (t.strokes % 6 === 2) k.vocal(liking > 0.55 ? 'purr' : 'coo', 0.3 + 0.4 * liking);
    if (t.strokes >= 8 && !t.placeNoted) {
      t.placeNoted = true;
      k.ltm.record({ kind: 'pet', subject: d.region, x: k.position.x, z: k.position.z, t: now, wall: Date.now(), valence: 0.4 + 0.5 * liking, note: `stroked on the ${d.region}` });
      k.learn.reinforcePlace(k.position.x, k.position.z, 0.62 + 0.3 * liking, 'petting spot');
      if (liking > 0.4) k.learn.shiftTrait('sociability', 0.004, 'enjoyed being stroked');
    }
  } else {
    k.affect.feel(-0.018, 0.02, 0.012);
    k.learn.adjustTouch(d.region, 0.004 * bond);
    if (t.strokes % 4 === 1) k.vocal('huff', 0.3);
    if (t.strokes > 5 + 10 * bond) {
      k.brain.onAnnoyed(d.x, d.z);
      if (t.strokes === Math.floor(6 + 10 * bond)) {
        k.learn.adjustBond(-0.006, `handled on the ${d.region} too long`);
        k.ltm.record({ kind: 'roughTouch', subject: d.region, x: k.position.x, z: k.position.z, t: now, wall: Date.now(), valence: -0.3, note: `did not like its ${d.region} being handled` });
      }
    }
  }
}

/** Messages every state understands unless it overrides them. */
class GlobalState extends State<Kinling> {
  override onMessage(k: Kinling, telegram: Telegram): boolean {
    switch (telegram.message) {
      case MSG.SOUND:
        handleSound(k, telegram.data as HeardSound);
        return true;
      case MSG.TOUCH:
        handleTouch(k, telegram.data as TouchData);
        return true;
      case MSG.CUE:
        k.brain.onCue((telegram.data as { kind: CueKind }).kind);
        return true;
    }
    return false;
  }
}

class FreeState extends State<Kinling> {
  override enter(k: Kinling): void {
    setMode(k, 'FREE');
    if (k.posture !== 'stand') { k.posture = 'stand'; k.postureT = 0; }
  }
}

class SettledState extends State<Kinling> {
  override enter(k: Kinling): void {
    setMode(k, 'SETTLED');
    k.stopTravel();
  }
}

/** Runs one action through its phases and fires its contact effects. */
class InteractState extends State<Kinling> {
  override enter(k: Kinling): void {
    setMode(k, 'INTERACT');
    if (k.action && k.action.kind !== 'pounce') k.stopTravel();
    if (k.action) k.world.events.emit('action', { kind: k.action.kind, phase: 'start' });
  }
  override execute(k: Kinling): void {
    const a = k.action;
    if (!a) { k.body.changeTo('FREE'); return; }
    a.t += k.dt;
    while (a.fired < a.spec.contacts.length && a.t >= a.spec.contacts[a.fired]) {
      const i = a.fired++;
      k.world.events.emit('action', { kind: a.kind, phase: 'contact' });
      a.onContact?.(i);
      if (k.action !== a) return; // a contact may have ended things
    }
    if (a.t >= a.duration) {
      k.action = null;
      k.world.events.emit('action', { kind: a.kind, phase: 'end' });
      a.onEnd?.(true);
      if (k.mode === 'INTERACT') k.body.changeTo(a.returnTo === 'SETTLED' ? 'SETTLED' : 'FREE');
    }
  }
  override exit(k: Kinling): void {
    const a = k.action;
    if (a) {
      // interrupted mid-action: let the owner restore a valid state
      k.action = null;
      k.world.events.emit('action', { kind: a.kind, phase: 'cancel' });
      a.onEnd?.(false);
    }
  }
}

class AsleepState extends State<Kinling> {
  override enter(k: Kinling): void {
    setMode(k, 'ASLEEP');
    k.stopTravel();
    k.posture = 'sleep';
    k.postureT = 0;
    k.sleepDepth = 0.15;
    k.stats.naps++;
  }
  override execute(k: Kinling): void {
    k.sleepDepth = clamp(k.sleepDepth + k.dt / 22, 0, 1);
    const n = k.needs;
    if (n.values.energy > 0.97 && k.world.night < 0.5) wake(k, 'rested');
    else if (n.values.energy > 0.55 && (n.urgency('nourishment') > 0.72 || n.urgency('hydration') > 0.72)) wake(k, 'need');
  }
}

/** Flinch → watch the source → shake it off. Interrupts whatever was going on. */
class StartledState extends State<Kinling> {
  private watchFor = 1;
  override enter(k: Kinling): void {
    const s = k.startle;
    setMode(k, 'STARTLED');
    k.brain.interrupt('startled');
    if (k.carrying) k.release(0.15);
    k.stopTravel();
    k.posture = 'stand';
    k.postureT = 0;
    k.riseT = 0;
    const dx = k.position.x - s.x, dz = k.position.z - s.z;
    const l = Math.hypot(dx, dz) || 1;
    const hop = 1.3 + 2.2 * s.strength;
    k.recoil.x += (dx / l) * hop; k.recoil.z += (dz / l) * hop;
    k.face(s.x, s.z);
    k.look(s.x, 0.15, s.z, 4, 5);
    k.alert = 1;
    k.affect.feel(-0.18 * s.strength, 0.55 * s.strength, 0.75 * s.strength);
    k.needs.add('security', -0.3 * s.strength);
    k.vocal('squeak', 0.5 + 0.5 * s.strength, 0);
    s.phase = 'flinch';
    s.t = 0;
    this.watchFor = 0.7 + 2.4 * s.strength * (0.5 + k.traits.sensitivity);
    k.ltm.record({ kind: 'startle', subject: s.kind, x: s.x, z: s.z, t: k.now, wall: Date.now(), valence: -0.5 * s.strength, note: `startled by a ${s.kind}` });
  }
  override execute(k: Kinling): void {
    const s = k.startle;
    s.t += k.dt;
    if (s.phase === 'flinch' && s.t > 0.42) { s.phase = 'watch'; s.t = 0; }
    else if (s.phase === 'watch') {
      k.face(s.x, s.z);
      k.look(s.x, 0.15, s.z, 0.5, 5);
      if (s.t > this.watchFor) { s.phase = 'recover'; s.t = 0; k.vocal('huff', 0.35); }
    } else if (s.phase === 'recover' && s.t > 0.95) {
      // it turned out to be harmless: the next one will matter a little less
      k.learn.habituate(s.kind, k.now);
      if (k.learn.habituation(s.kind, k.now) > 0.6) k.learn.shiftTrait('confidence', 0.006, `got used to the ${s.kind}`);
      k.body.changeTo('FREE');
    }
  }
  override exit(k: Kinling): void {
    k.startle.phase = 'none';
    k.brain.resume();
  }
  override onMessage(k: Kinling, telegram: Telegram): boolean {
    // while frightened, a new noise deepens it rather than restarting it
    if (telegram.message === MSG.SOUND) {
      const d = telegram.data as HeardSound;
      k.senses.hear(d);
      k.startle.strength = clamp01(k.startle.strength + 0.1);
      return true;
    }
    return false;
  }
}

export function createBodyMachine(k: Kinling): StateMachine<Kinling> {
  const fsm = new StateMachine<Kinling>(k);
  fsm.globalState = new GlobalState();
  fsm.add('FREE', new FreeState());
  fsm.add('SETTLED', new SettledState());
  fsm.add('INTERACT', new InteractState());
  fsm.add('ASLEEP', new AsleepState());
  fsm.add('STARTLED', new StartledState());
  fsm.currentState = fsm.get('FREE');
  return fsm;
}
