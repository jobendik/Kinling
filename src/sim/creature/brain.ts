/**
 * Motivation and intention. A Yuka Think arbitrates between custom
 * GoalEvaluators; each evaluator turns needs, opportunities (as perceived),
 * personality, memory, learned preferences, costs and feasibility into a
 * desirability and exposes the terms it used, so the developer inspector can
 * show exactly why a goal won.
 *
 * Stability comes from a hysteresis bonus for the running activity, a
 * commitment period during which only urgent alternatives may pre-empt it,
 * and cooldowns after an activity ends or fails.
 */
import {
  FuzzyAND, FuzzyModule, FuzzyRule, FuzzyVariable, GameEntity, Goal, GoalEvaluator, LeftShoulderFuzzySet,
  RightShoulderFuzzySet, Think, TriangularFuzzySet,
} from 'yuka';
import { clamp01, smoothstep } from '../../core/math';
import { Berry, Curio, Toy, Wisp } from '../entities';
import { BUSH, nearestShore } from '../terrain';
import type { ActionKind, CueKind, ToyKind } from '../types';
import type { Kinling } from './Kinling';
import {
  Activity, CueGoal, DrinkGoal, EatGoal, EvadeGoal, ExploreGoal, FetchGoal, GreetGoal, IdleGoal, InvestigateGoal, InviteGoal,
  LureGoal, RestGoal, SafetyGoal, SocialGoal, SoloPlayGoal, type Approach, type CueResponse,
} from './goals';
import { Senses } from './senses';

const HYSTERESIS = 0.1;
const DIST_COST = 0.022;

export interface ScoreTerm { name: string; value: number }

export abstract class KEvaluator extends GoalEvaluator<Kinling> {
  abstract readonly name: string;
  terms: ScoreTerm[] = [];
  raw = 0;
  final = 0;
  /** Seconds the resulting activity is protected from casual pre-emption. */
  commit = 4;
  /** Rest period after the activity ends (done) or fails. */
  cooldownDone = 0;
  cooldownFail = 12;
  /** Does the activity keep whatever is being carried? */
  keepsCarry = false;
  protected t(name: string, value: number): number {
    this.terms.push({ name, value });
    return value;
  }
  protected abstract score(k: Kinling): number;
  abstract create(k: Kinling): Activity;
  /** May this evaluator break another activity's commitment? */
  urgent(_k: Kinling, _score: number): boolean {
    return false;
  }
  override calculateDesirability(k: Kinling): number {
    const b = k.brain;
    this.terms = [];
    let s = b.cooldownLeft(this) > 0 ? 0 : clamp01(this.score(k));
    this.raw = s;
    if (b.current === this && b.activity) s += HYSTERESIS;
    else if (b.activity && b.commitLeft > 0 && !this.urgent(k, s * this.characterBias)) s *= 0.45;
    this.final = s * this.characterBias;
    return s;
  }
  override setGoal(k: Kinling): void {
    k.brain.adopt(this);
  }
}

// ── fuzzy appraisals ─────────────────────────────────────────────
/** Gradual judgement of how much it wants to rest, from energy and darkness. */
function buildRestModule(): FuzzyModule {
  const fm = new FuzzyModule();
  const energy = new FuzzyVariable();
  const eLow = new LeftShoulderFuzzySet(0, 0.18, 0.42);
  const eMid = new TriangularFuzzySet(0.18, 0.45, 0.75);
  const eHigh = new RightShoulderFuzzySet(0.45, 0.78, 1);
  energy.add(eLow).add(eMid).add(eHigh);
  fm.addFLV('energy', energy);
  const dark = new FuzzyVariable();
  const dDay = new LeftShoulderFuzzySet(0, 0.15, 0.5);
  const dDusk = new TriangularFuzzySet(0.15, 0.5, 0.85);
  const dNight = new RightShoulderFuzzySet(0.5, 0.85, 1);
  dark.add(dDay).add(dDusk).add(dNight);
  fm.addFLV('dark', dark);
  const want = new FuzzyVariable();
  const wNo = new LeftShoulderFuzzySet(0, 0.12, 0.4);
  const wSome = new TriangularFuzzySet(0.12, 0.45, 0.78);
  const wMuch = new RightShoulderFuzzySet(0.45, 0.82, 1);
  want.add(wNo).add(wSome).add(wMuch);
  fm.addFLV('want', want);
  fm.addRule(new FuzzyRule(new FuzzyAND(eLow, dDay), wMuch));
  fm.addRule(new FuzzyRule(new FuzzyAND(eLow, dDusk), wMuch));
  fm.addRule(new FuzzyRule(new FuzzyAND(eLow, dNight), wMuch));
  fm.addRule(new FuzzyRule(new FuzzyAND(eMid, dDay), wNo));
  fm.addRule(new FuzzyRule(new FuzzyAND(eMid, dDusk), wSome));
  fm.addRule(new FuzzyRule(new FuzzyAND(eMid, dNight), wMuch));
  fm.addRule(new FuzzyRule(new FuzzyAND(eHigh, dDay), wNo));
  fm.addRule(new FuzzyRule(new FuzzyAND(eHigh, dDusk), wNo));
  fm.addRule(new FuzzyRule(new FuzzyAND(eHigh, dNight), wSome));
  return fm;
}

/** How carefully to approach something, from its novelty and the creature's nerve. */
function buildCautionModule(): FuzzyModule {
  const fm = new FuzzyModule();
  const nov = new FuzzyVariable();
  const nKnown = new LeftShoulderFuzzySet(0, 0.2, 0.5);
  const nOdd = new TriangularFuzzySet(0.2, 0.55, 0.85);
  const nStrange = new RightShoulderFuzzySet(0.55, 0.88, 1);
  nov.add(nKnown).add(nOdd).add(nStrange);
  fm.addFLV('novelty', nov);
  const nerve = new FuzzyVariable();
  const vTimid = new LeftShoulderFuzzySet(0, 0.22, 0.48);
  const vSteady = new TriangularFuzzySet(0.22, 0.5, 0.78);
  const vBold = new RightShoulderFuzzySet(0.5, 0.78, 1);
  nerve.add(vTimid).add(vSteady).add(vBold);
  fm.addFLV('nerve', nerve);
  const caution = new FuzzyVariable();
  const cLow = new LeftShoulderFuzzySet(0, 0.15, 0.42);
  const cMid = new TriangularFuzzySet(0.15, 0.5, 0.85);
  const cHigh = new RightShoulderFuzzySet(0.55, 0.85, 1);
  caution.add(cLow).add(cMid).add(cHigh);
  fm.addFLV('caution', caution);
  fm.addRule(new FuzzyRule(new FuzzyAND(nKnown, vTimid), cMid));
  fm.addRule(new FuzzyRule(new FuzzyAND(nKnown, vSteady), cLow));
  fm.addRule(new FuzzyRule(new FuzzyAND(nKnown, vBold), cLow));
  fm.addRule(new FuzzyRule(new FuzzyAND(nOdd, vTimid), cHigh));
  fm.addRule(new FuzzyRule(new FuzzyAND(nOdd, vSteady), cMid));
  fm.addRule(new FuzzyRule(new FuzzyAND(nOdd, vBold), cLow));
  fm.addRule(new FuzzyRule(new FuzzyAND(nStrange, vTimid), cHigh));
  fm.addRule(new FuzzyRule(new FuzzyAND(nStrange, vSteady), cHigh));
  fm.addRule(new FuzzyRule(new FuzzyAND(nStrange, vBold), cMid));
  return fm;
}

const playGate = (k: Kinling): number => smoothstep(0.12, 0.4, k.needs.values.energy) * (1 - k.affect.wariness);

// ── evaluators ───────────────────────────────────────────────────
class EatEvaluator extends KEvaluator {
  readonly name = 'eat';
  override commit = 6;
  override cooldownFail = 20;
  protected score(k: Kinling): number {
    const hunger = this.t('hunger', k.needs.urgency('nourishment'));
    const berry = k.senses.nearestBerry();
    let avail = 0, dist = 0, treat = 0;
    if (berry) {
      const p = k.senses.believed(berry)!;
      dist = k.distanceTo(p.x, p.z);
      avail = 1;
      if (berry.fromPlayer && k.now - berry.bornAt < 40) treat = (0.26 + 0.2 * k.learn.data.bond) * (1 - smoothstep(0.9, 1, k.needs.values.nourishment));
    } else if (k.world.bushStock > 0) {
      avail = 0.85;
      dist = k.distanceTo(BUSH.x, BUSH.z);
    }
    this.t('food known', avail);
    this.t('treat', treat);
    if (avail === 0) return hunger > 0.45 ? this.t('ask', hunger * 0.5) : 0;
    return hunger * 1.05 * avail + treat - this.t('distance', dist * DIST_COST);
  }
  override urgent(k: Kinling, s: number): boolean {
    return s > 0.72;
  }
  create(k: Kinling): Activity {
    return new EatGoal(k);
  }
}

class DrinkEvaluator extends KEvaluator {
  readonly name = 'drink';
  override commit = 7;
  protected score(k: Kinling): number {
    const thirst = this.t('thirst', k.needs.urgency('hydration'));
    const s = nearestShore(k.position.x, k.position.z);
    return thirst * 1.05 - this.t('distance', k.distanceTo(s.x, s.z) * DIST_COST);
  }
  override urgent(_k: Kinling, s: number): boolean {
    return s > 0.72;
  }
  create(k: Kinling): Activity {
    return new DrinkGoal(k);
  }
}

class RestEvaluator extends KEvaluator {
  readonly name = 'rest';
  override commit = 12;
  override cooldownDone = 25;
  protected score(k: Kinling): number {
    if (k.asleep) return 1;
    const fatigue = this.t('fatigue', k.needs.urgency('energy'));
    const fuzzy = this.t('fuzzy(energy, dark)', k.brain.restDesire());
    const calm = this.t('calm', 1 - 0.6 * k.affect.wariness - 0.25 * Math.max(0, k.affect.arousal - 0.6));
    return Math.max(fatigue * 1.1, fuzzy * 0.9) * calm;
  }
  override urgent(_k: Kinling, s: number): boolean {
    return s > 0.8;
  }
  create(k: Kinling): Activity {
    return new RestGoal(k);
  }
}

/** Chasing something the player has just thrown: an invitation it may accept or let pass. */
class FetchEvaluator extends KEvaluator {
  readonly name: string;
  override commit = 7;
  override cooldownFail = 25;
  override cooldownDone = 2;
  override keepsCarry = true;
  constructor(private kind: ToyKind) {
    super();
    this.name = `fetch ${kind}`;
  }
  protected score(k: Kinling): number {
    const toy = k.world.toys[this.kind];
    if (toy.state !== 'free' && k.carrying !== toy) return 0;
    const since = k.now - toy.thrownAt;
    if (since > 9 && !(k.brain.current === this)) return 0;
    if (k.senses.age(toy) > 4 && k.brain.current !== this) return 0; // it has to have noticed the throw
    const drive = this.t('chase drive', smoothstep(9, 2, since) * 0.62);
    const liking = this.t('liking', 0.45 + 0.9 * k.learn.data.affinity[this.kind]);
    const gate = this.t('energy·calm', playGate(k));
    const want = this.t('wants play', 0.55 + 0.45 * k.needs.urgency('stimulation'));
    return drive * liking * gate * want + (k.brain.current === this ? 0.3 : 0);
  }
  override urgent(k: Kinling): boolean {
    // a thrown toy can break into idle pursuits, not into eating, drinking or sleep
    const cur = k.brain.current?.name ?? '';
    return cur === 'idle' || cur === 'explore' || cur.startsWith('play') || cur === 'seek company' || cur.startsWith('offer');
  }
  create(k: Kinling): Activity {
    return new FetchGoal(k, k.world.toys[this.kind]);
  }
}

/** Self-directed play; the learned liking for each toy decides which one it goes for. */
class SoloPlayEvaluator extends KEvaluator {
  readonly name: string;
  override commit = 8;
  override cooldownDone = 30;
  override cooldownFail = 40;
  override keepsCarry = true;
  constructor(private kind: ToyKind) {
    super();
    this.name = `play ${kind}`;
  }
  protected score(k: Kinling): number {
    const toy = k.world.toys[this.kind];
    const bel = k.senses.believed(toy);
    if (!bel || (toy.state !== 'free' && k.carrying !== toy)) return 0;
    if (k.learn.familiarity(this.kind) < 0.3) return 0; // it investigates new toys before playing with them
    const stim = this.t('boredom', k.needs.urgency('stimulation'));
    const liking = this.t('liking', 0.3 + 1.1 * k.learn.data.affinity[this.kind]);
    const gate = this.t('energy·calm', playGate(k));
    const day = this.t('awake hours', 1 - 0.5 * k.world.night);
    return stim * liking * gate * day - this.t('distance', k.distanceTo(bel.x, bel.z) * DIST_COST);
  }
  create(k: Kinling): Activity {
    return new SoloPlayGoal(k, k.world.toys[this.kind]);
  }
}

class LureEvaluator extends KEvaluator {
  readonly name = 'chase wisp';
  override commit = 5;
  override cooldownDone = 6;
  override cooldownFail = 10;
  protected score(k: Kinling): number {
    const w = k.world.wisp;
    if (!w.on || k.senses.age(w) > 3) return 0;
    if (k.learn.familiarity('wisp') < 0.3) return 0;
    const liking = this.t('liking', 0.4 + 0.9 * k.learn.data.affinity.wisp);
    const gate = this.t('energy·calm', playGate(k));
    const lively = this.t('movement', 0.6 + 0.4 * smoothstep(0.1, 1.2, w.velocity.length()));
    const want = this.t('wants play', 0.6 + 0.4 * k.needs.urgency('stimulation'));
    return 0.62 * liking * gate * lively * want;
  }
  override urgent(k: Kinling): boolean {
    const cur = k.brain.current?.name ?? '';
    return cur === 'idle' || cur === 'explore' || cur === 'seek company';
  }
  create(k: Kinling): Activity {
    return new LureGoal(k);
  }
}

class InvestigateEvaluator extends KEvaluator {
  readonly name = 'investigate';
  override commit = 6;
  override cooldownDone = 3;
  override cooldownFail = 15;
  target: GameEntity | null = null;
  approach: Approach = 'wary';
  protected score(k: Kinling): number {
    let best: GameEntity | null = null, bs = 0;
    for (const rec of k.senses.current()) {
      const e = rec.entity;
      if (!e || e instanceof Berry) continue;
      if (e instanceof Toy && e.state !== 'free') continue;
      if (e instanceof Wisp && !e.on) continue;
      const kind = Senses.describe(e);
      const fam = k.learn.familiarity(kind);
      if (fam > 0.74) continue;
      const since = k.now - (k.brain.investigatedAt[kind] ?? -1e9);
      if (since < 14 + 30 * fam) continue;
      const s = (1 - fam) * (e instanceof Curio ? 1.1 : 1) - rec.lastSensedPosition.distanceTo(k.position) * DIST_COST;
      if (s > bs) { bs = s; best = e; }
    }
    if (k.brain.current === this && this.target && k.brain.activity) best = this.target;
    else this.target = best;
    if (!best) return 0;
    const novelty = this.t('novelty', 1 - k.learn.familiarity(Senses.describe(best)));
    const caution = this.t('fuzzy caution', k.brain.caution(novelty));
    this.approach = caution < 0.36 ? 'bold' : caution < 0.68 ? 'wary' : 'timid';
    const interest = this.t('interest', k.affect.interest * 0.18);
    const calm = this.t('calm', 1 - 0.55 * k.affect.wariness);
    return (0.34 + 0.5 * novelty) * calm + interest;
  }
  create(k: Kinling): Activity {
    return new InvestigateGoal(k, this.target!, this.approach);
  }
}

class SocialEvaluator extends KEvaluator {
  readonly name = 'seek company';
  override commit = 6;
  override cooldownDone = 20;
  override cooldownFail = 70;
  protected score(k: Kinling): number {
    const pettedNow = k.now - k.touch.at < 1.6 && k.touch.liked >= 0;
    if (pettedNow) return this.t('being stroked', 0.72);
    const lonely = this.t('wants company', k.needs.urgency('social'));
    const bond = this.t('trust', 0.4 + 0.9 * k.learn.data.bond);
    const around = this.t('you are around', k.now - k.world.playerActiveAt < 90 ? 1 : 0.7);
    const calm = this.t('calm', 1 - 0.7 * k.affect.wariness);
    const p = k.world.playerSpot;
    return lonely * bond * around * calm - this.t('distance', k.distanceTo(p.x, p.z) * DIST_COST);
  }
  override urgent(k: Kinling): boolean {
    return k.now - k.touch.at < 1.6 && k.touch.liked >= 0 && (k.brain.current?.name === 'idle' || k.brain.current?.name === 'explore');
  }
  create(k: Kinling): Activity {
    return new SocialGoal(k);
  }
}

class InviteEvaluator extends KEvaluator {
  readonly name = 'offer a toy';
  override commit = 8;
  override cooldownDone = 50;
  override cooldownFail = 80;
  override keepsCarry = true;
  private pick: ToyKind = 'ball';
  protected score(k: Kinling): number {
    // which toy? the one it has come to like best, if it knows where it is
    let best: ToyKind | null = null;
    for (const kind of ['ball', 'rattle'] as const) {
      const toy = k.world.toys[kind];
      if (toy.state !== 'free' || !k.senses.believed(toy) || k.learn.familiarity(kind) < 0.3) continue;
      if (!best || k.learn.data.affinity[kind] > k.learn.data.affinity[best]) best = kind;
    }
    if (!best) return 0;
    if (!(k.brain.current === this && k.brain.activity)) this.pick = best;
    const stim = this.t('boredom', k.needs.urgency('stimulation'));
    const bond = this.t('trust', 0.25 + 1.0 * k.learn.data.bond);
    const gate = this.t('energy·calm', playGate(k));
    const liking = this.t('liking', 0.4 + 0.8 * k.learn.data.affinity[this.pick]);
    const reunion = this.t('just reunited', k.now < k.brain.wantInviteUntil ? 0.45 : 0);
    const day = 1 - 0.5 * k.world.night;
    return (stim * 0.9 + reunion) * bond * gate * liking * day;
  }
  create(k: Kinling): Activity {
    return new InviteGoal(k, k.world.toys[this.pick]);
  }
}

class ExploreEvaluator extends KEvaluator {
  readonly name = 'explore';
  override commit = 5;
  override cooldownDone = 6;
  protected score(k: Kinling): number {
    const base = this.t('base', 0.17);
    const stim = this.t('boredom', 0.22 * k.needs.urgency('stimulation'));
    const gate = this.t('energy', smoothstep(0.15, 0.45, k.needs.values.energy));
    const day = this.t('daylight', 1 - 0.6 * k.world.night);
    return (base + stim + 0.1 * k.affect.arousal) * gate * day * (1 - 0.5 * k.affect.wariness);
  }
  create(k: Kinling): Activity {
    return new ExploreGoal(k);
  }
}

class IdleEvaluator extends KEvaluator {
  readonly name = 'idle';
  override commit = 3;
  protected score(k: Kinling): number {
    return this.t('base', 0.15) + this.t('ease', 0.08 * (1 - k.affect.arousal));
  }
  create(k: Kinling): Activity {
    return new IdleGoal(k);
  }
}

class CueEvaluator extends KEvaluator {
  readonly name = 'answer cue';
  override commit = 5;
  protected score(k: Kinling): number {
    const c = k.brain.pendingCue;
    if (!c) return 0;
    if (k.now - c.issuedAt > 30) { k.brain.pendingCue = null; return 0; }
    if (k.brain.current === this && k.brain.activity) return 0.9;
    return this.t('cue pending', k.now >= c.readyAt ? 0.9 : 0);
  }
  override urgent(k: Kinling): boolean {
    // it will not abandon eating, drinking or sleep for a cue; that is what "postpone" means
    const cur = k.brain.current?.name ?? '';
    return !(cur === 'eat' || cur === 'drink' || cur === 'rest');
  }
  create(k: Kinling): Activity {
    const c = k.brain.pendingCue!;
    k.brain.pendingCue = null;
    return new CueGoal(k, c.kind, c.response, c.offered);
  }
}

class SafetyEvaluator extends KEvaluator {
  readonly name = 'seek safety';
  override commit = 8;
  override cooldownDone = 15;
  protected score(k: Kinling): number {
    const fear = this.t('wariness', k.affect.wariness);
    const insecure = this.t('insecurity', 1 - k.needs.values.security);
    if (k.brain.current === this && k.brain.activity) return 0.5 + fear * 0.5;
    return fear * 1.15 + insecure * 0.45 - 0.42;
  }
  override urgent(): boolean {
    return true;
  }
  create(k: Kinling): Activity {
    return new SafetyGoal(k);
  }
}

class GreetEvaluator extends KEvaluator {
  readonly name = 'greet';
  override commit = 6;
  protected score(k: Kinling): number {
    if (k.world.reunionPending <= 0) return 0;
    if (k.brain.current === this && k.brain.activity) return 0.9;
    const missed = this.t('time apart', smoothstep(60, 3600, k.world.reunionPending));
    const bond = this.t('trust', 0.35 + 0.9 * k.learn.data.bond);
    return (0.55 + 0.4 * missed) * bond * (1 - 0.6 * k.affect.wariness);
  }
  override urgent(k: Kinling): boolean {
    return k.brain.current?.name !== 'rest';
  }
  create(k: Kinling): Activity {
    return new GreetGoal(k);
  }
}

class EvadeEvaluator extends KEvaluator {
  readonly name = 'move away';
  override commit = 3;
  protected score(k: Kinling): number {
    return k.now < k.brain.annoyedUntil ? 0.85 : 0;
  }
  override urgent(): boolean {
    return true;
  }
  create(k: Kinling): Activity {
    k.brain.annoyedUntil = 0;
    return new EvadeGoal(k, k.brain.annoyedFrom);
  }
}

export interface PendingCue {
  kind: CueKind;
  response: CueResponse;
  offered: ActionKind;
  issuedAt: number;
  readyAt: number;
}

export class Brain {
  readonly think: Think<Kinling>;
  readonly evaluators: KEvaluator[] = [];
  current: KEvaluator | null = null;
  activity: Activity | null = null;
  commitLeft = 0;
  suspended = false;
  private arbTimer = 0;
  private cooldowns = new Map<string, number>();
  private restFuzzy = buildRestModule();
  private cautionFuzzy = buildCautionModule();
  private restCache = { at: -1, value: 0 };

  pendingCue: PendingCue | null = null;
  lastRewardAt = -1e9;
  wokeBy: 'rested' | 'touch' | 'noise' | 'need' = 'rested';
  lastHabituated: Record<string, number> = {};
  investigatedAt: Record<string, number> = {};
  wantInviteUntil = -1;
  annoyedUntil = -1;
  annoyedFrom = { x: 0, z: 0 };
  /** Last few decisions, for the inspector. */
  history: Array<{ t: number; name: string; reason: string }> = [];

  constructor(private k: Kinling) {
    this.think = new Think<Kinling>(k);
    const t = k.traits;
    const add = (e: KEvaluator, bias = 1): void => {
      e.characterBias = bias;
      this.evaluators.push(e);
      this.think.addEvaluator(e);
    };
    // personality enters through Yuka's characterBias on each evaluator
    const playful = 0.72 + 0.56 * t.playfulness;
    const curious = 0.72 + 0.56 * t.curiosity;
    const social = 0.72 + 0.56 * t.sociability;
    add(new EatEvaluator());
    add(new DrinkEvaluator());
    add(new RestEvaluator());
    add(new FetchEvaluator('ball'), playful);
    add(new FetchEvaluator('rattle'), playful);
    add(new SoloPlayEvaluator('ball'), playful);
    add(new SoloPlayEvaluator('rattle'), playful);
    add(new LureEvaluator(), playful);
    add(new InvestigateEvaluator(), curious);
    add(new SocialEvaluator(), social);
    add(new InviteEvaluator(), (playful + social) / 2);
    add(new ExploreEvaluator(), curious);
    add(new IdleEvaluator());
    add(new CueEvaluator());
    add(new SafetyEvaluator(), 1.3 - 0.6 * t.confidence);
    add(new GreetEvaluator(), social);
    add(new EvadeEvaluator());
  }

  /** Personality drifts slowly; keep the biases in step with it. */
  refreshBias(): void {
    const t = this.k.traits;
    const playful = 0.72 + 0.56 * t.playfulness, curious = 0.72 + 0.56 * t.curiosity, social = 0.72 + 0.56 * t.sociability;
    for (const e of this.evaluators) {
      if (e instanceof FetchEvaluator || e instanceof SoloPlayEvaluator || e instanceof LureEvaluator) e.characterBias = playful;
      else if (e instanceof InvestigateEvaluator || e instanceof ExploreEvaluator) e.characterBias = curious;
      else if (e instanceof SocialEvaluator || e instanceof GreetEvaluator) e.characterBias = social;
      else if (e instanceof InviteEvaluator) e.characterBias = (playful + social) / 2;
      else if (e instanceof SafetyEvaluator) e.characterBias = 1.3 - 0.6 * t.confidence;
    }
  }

  cooldownLeft(e: KEvaluator): number {
    return Math.max(0, (this.cooldowns.get(e.name) ?? -1e9) - this.k.now);
  }

  restDesire(): number {
    const k = this.k;
    if (this.restCache.at === k.now) return this.restCache.value;
    this.restFuzzy.fuzzify('energy', clamp01(k.needs.values.energy));
    this.restFuzzy.fuzzify('dark', clamp01(k.world.night));
    const v = clamp01(this.restFuzzy.defuzzify('want'));
    this.restCache = { at: k.now, value: v };
    return v;
  }

  /** Fuzzy caution in [0,1] for approaching something of the given novelty. */
  caution(novelty: number): number {
    const k = this.k;
    const nerve = clamp01(0.62 * k.traits.confidence + 0.38 * k.needs.values.security - 0.5 * k.affect.wariness + 0.1 * k.traits.curiosity);
    this.cautionFuzzy.fuzzify('novelty', clamp01(novelty));
    this.cautionFuzzy.fuzzify('nerve', nerve);
    return clamp01(this.cautionFuzzy.defuzzify('caution'));
  }

  // ── Think integration ──────────────────────────────────────────
  adopt(e: KEvaluator): void {
    const k = this.k;
    if (e === this.current && this.activity && this.think.hasSubgoals()) return;
    const prev = this.current;
    this.think.clearSubgoals(); // terminates the old activity → its cleanup runs
    if (k.carrying && !e.keepsCarry) k.release(0.2);
    this.current = e;
    this.activity = e.create(k);
    this.think.addSubgoal(this.activity);
    this.commitLeft = e.commit;
    const top = [...e.terms].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 2).map((t) => `${t.name} ${t.value.toFixed(2)}`).join(', ');
    const reason = `${top || 'default'}${prev && prev !== e ? ` · over ${prev.name}` : ''}`;
    this.history.push({ t: k.now, name: this.activity.label, reason });
    if (this.history.length > 14) this.history.shift();
    k.world.events.emit('goal', { name: this.activity.label, reason });
  }

  /** Called by an activity as it terminates, however it ended. */
  activityEnded(a: Activity): void {
    if (a !== this.activity) return;
    const e = this.current;
    if (e) {
      const cd = a.status === Goal.STATUS.COMPLETED ? e.cooldownDone : a.status === Goal.STATUS.FAILED ? e.cooldownFail : Math.min(e.cooldownDone, 4);
      if (cd > 0) this.cooldowns.set(e.name, this.k.now + cd * (0.8 + 0.4 * this.k.rng.next()));
    }
    this.activity = null;
    this.commitLeft = 0;
  }

  /** Drop the current activity at once (a fright). Its cleanup still runs. */
  interrupt(_why: string): void {
    this.suspended = true;
    this.think.clearSubgoals();
    this.think.status = Goal.STATUS.INACTIVE;
    this.current = null;
    this.activity = null;
  }
  resume(): void {
    this.suspended = false;
    this.arbTimer = 0;
  }

  update(dt: number): void {
    const k = this.k;
    if (this.suspended) return;
    this.commitLeft -= dt;
    this.arbTimer -= dt;
    if (k.asleep) {
      // asleep: no deliberation, but the resting activity keeps watch for waking
      if (!this.activity) this.think.arbitrate();
      this.think.execute();
      return;
    }
    if (!this.think.hasSubgoals() || this.arbTimer <= 0) {
      this.think.arbitrate();
      this.arbTimer = 0.5;
    }
    this.think.execute();
  }

  // ── events from the senses and the body ────────────────────────
  onNotice(e: GameEntity, info: { first: boolean; moved: boolean }): void {
    const k = this.k;
    const kind = Senses.describe(e);
    const novelty = 1 - k.learn.familiarity(kind);
    k.look(e.position.x, e.position.y, e.position.z, 1.2 + novelty * 1.6, 2);
    k.affect.interest = clamp01(k.affect.interest + 0.15 + 0.35 * novelty + (info.moved ? 0.2 : 0));
    k.alert = Math.max(k.alert, 0.4 + 0.5 * novelty);
    if (info.moved && e instanceof Toy) {
      k.ltm.record({ kind: 'foundToy', subject: e.kind, x: e.position.x, z: e.position.z, t: k.now, wall: Date.now(), valence: 0.1, salience: 0.15, note: `the ${e.kind} was somewhere new` });
    }
    this.arbTimer = Math.min(this.arbTimer, 0.15);
  }

  onReward(_kind: 'touch' | 'food'): void {
    this.lastRewardAt = this.k.now;
  }

  onPoke(): void {
    const k = this.k;
    // a playful, lively individual takes a poke as an invitation
    if (k.mode === 'FREE' && k.traits.playfulness > 0.5 && k.affect.arousal > 0.4 && k.needs.values.energy > 0.35 && k.rng.chance(0.6)) {
      if (k.perform('playBow')) k.vocal('chirp', 0.6);
    }
  }

  onAnnoyed(x: number, z: number): void {
    this.annoyedUntil = this.k.now + 3;
    this.annoyedFrom = { x, z };
    this.arbTimer = 0;
  }

  /**
   * A cue was heard. The creature decides, there and then, whether to answer
   * now, answer later, try something, or let it pass — from the learned
   * association strength, its trust in the player, and its current state.
   */
  onCue(kind: CueKind): void {
    const k = this.k;
    const ev = k.world.events;
    if (k.asleep) {
      k.sleepDepth = Math.max(0, k.sleepDepth - 0.15);
      ev.emit('cue', { kind, response: 'unheard', detail: 'asleep' });
      return;
    }
    if (k.mode === 'STARTLED') { ev.emit('cue', { kind, response: 'unheard', detail: 'frightened' }); return; }
    k.lookAtPlayer(1.6, 3);
    k.alert = Math.max(k.alert, 0.7);
    const s = k.learn.data.cues[kind].strength;
    const bond = k.learn.data.bond;
    const busy = this.current?.name ?? '';
    const roll = k.rng.next();
    const now = k.now;
    let response: CueResponse;
    let offered: ActionKind = 'headTilt';
    let readyAt = now;
    let detail = '';
    if (kind === 'come') {
      const fatigue = 1 - k.needs.values.energy;
      const willing = clamp01(0.12 + 0.58 * s + 0.22 * bond + 0.1 * k.traits.sociability - 0.35 * k.affect.wariness - 0.25 * Math.max(0, fatigue - 0.6));
      const mustFinish = busy === 'eat' || busy === 'drink';
      if (roll < willing) {
        response = 'accept';
        if (mustFinish) { readyAt = now + 30; detail = `after it finishes (${busy})`; }
      } else if (roll < willing + 0.24) {
        response = 'accept';
        readyAt = now + 3.5 + k.rng.range(0, 5);
        detail = 'in a moment';
      } else {
        response = 'decline';
        detail = fatigue > 0.7 ? 'too tired' : k.affect.wariness > 0.4 ? 'too wary' : 'not just now';
      }
      ev.emit('cue', { kind, response: response === 'accept' ? (readyAt > now ? 'postpone' : 'accept') : 'decline', detail });
    } else {
      const d = k.distanceTo(k.world.playerSpot.x, k.world.playerSpot.z);
      const attention = clamp01(1.15 - d / 9) * (1 - 0.6 * k.affect.wariness);
      const p = clamp01(0.03 + 0.93 * s) * (0.55 + 0.45 * attention);
      if (busy === 'eat' || busy === 'drink' || busy === 'rest') {
        response = 'decline';
        detail = `busy (${busy})`;
      } else if (roll < p) {
        response = 'correct';
      } else if (roll < p + (1 - p) * (0.35 + 0.4 * k.traits.playfulness)) {
        response = 'offered';
        offered = k.rng.pick(['playBow', 'headTilt', 'chirp', 'spin', 'pawAt'] as const);
        detail = offered;
      } else response = 'puzzled';
      readyAt = now + 0.25 + 0.9 * (1 - s) * k.rng.next();
      ev.emit('cue', { kind, response: response === 'decline' ? 'decline' : response, detail });
    }
    this.pendingCue = { kind, response, offered, issuedAt: now, readyAt };
    this.arbTimer = Math.min(this.arbTimer, Math.max(0, readyAt - now));
  }
}
