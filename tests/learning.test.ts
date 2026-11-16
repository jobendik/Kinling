import { describe, expect, it } from 'vitest';
import { applyAbsence, ABSENCE_CAP_S } from '../src/sim/offline';
import { parseSave, restore, serialize } from '../src/sim/save';
import { NEED_KEYS } from '../src/sim/needs';
import { isWalkable } from '../src/sim/terrain';
import type { World } from '../src/sim/world';
import { goalLog, makeWorld, run } from './helpers';

const familiar = (w: World): void => { for (const k of ['ball', 'rattle', 'berry', 'wisp', 'hand']) w.kinling.learn.data.familiarity[k] = 1; };
const score = (w: World, name: string): number => {
  const e = w.kinling.brain.evaluators.find((x) => x.name === name)!;
  return e.calculateDesirability(w.kinling) * e.characterBias;
};
/** Put two worlds in the same situation so only what was learned differs. */
const comparable = (w: World): void => {
  const k = w.kinling;
  k.brain.interrupt('test');
  k.brain.resume();
  if (k.mode !== 'FREE') { k.rise(); k.riseT = 0; }
  k.place(0, 0, 0);
  Object.assign(k.needs.values, { nourishment: 0.9, hydration: 0.9, energy: 0.9, stimulation: 0.2, social: 0.9, security: 0.9 });
  k.affect.wariness = 0; k.affect.valence = 0.2; k.affect.arousal = 0.5;
  w.dayTime = 0.5;
  w.toys.ball.position.set(1.2, w.toys.ball.position.y, 1.2);
  w.toys.rattle.position.set(-1.2, w.toys.rattle.position.y, 1.2);
  for (const t of [w.toys.ball, w.toys.rattle]) { t.state = 'free'; t.resting = true; t.velocity.set(0, 0, 0); t.thrownAt = -1e9; }
  k.carrying = null;
  k.brain.suspended = true;
  run(w, 1.2);
};

describe('play preferences are learned from outcomes', () => {
  it('repeated good games of fetch raise the stored liking and change later choices', () => {
    const trained = makeWorld(33), control = makeWorld(33);
    for (const w of [trained, control]) { familiar(w); w.kinling.learn.data.bond = 0.7; }
    const k = trained.kinling;
    const before = k.learn.data.affinity.ball;
    // play real games: throw, let it chase, catch and decide what to do, throw again
    let throws = 0;
    for (let i = 0; i < 60 * 150 && throws < 9; i++) {
      trained.step(1 / 60);
      k.needs.values.energy = Math.max(k.needs.values.energy, 0.7);
      k.needs.values.nourishment = 0.9; k.needs.values.hydration = 0.9;
      const ball = trained.toys.ball;
      if (ball.state === 'free' && ball.resting && trained.time - ball.thrownAt > 5 && !k.action) {
        const a = throws * 1.9;
        trained.tossToy('ball', Math.sin(a) * 2.6, Math.cos(a) * 2.2 + 0.6);
        throws++;
      }
    }
    run(trained, 12);
    k.brain.interrupt('end of session');
    k.brain.resume();
    expect(k.learn.data.plays.ball).toBeGreaterThan(0);
    expect(k.stats.catches).toBeGreaterThan(0);
    const after = k.learn.data.affinity.ball;
    expect(after).toBeGreaterThan(before + 0.05);
    expect(k.ltm.recall('play', 'ball')).not.toBeNull();

    // same situation, same individual: only the experience differs
    comparable(trained); comparable(control);
    const tb = score(trained, 'play ball'), tr = score(trained, 'play rattle');
    const cb = score(control, 'play ball');
    expect(tb).toBeGreaterThan(cb);
    expect(tb).toBeGreaterThan(tr);
    // and the choice it actually makes follows
    trained.kinling.brain.suspended = false;
    const log = goalLog(trained);
    run(trained, 3);
    expect(log[0]).toContain('ball');

    // the preference survives a save and reload
    const reloaded = restore(parseSave(JSON.stringify(serialize(trained)))!);
    expect(reloaded.kinling.learn.data.affinity.ball).toBeCloseTo(trained.kinling.learn.data.affinity.ball, 9);
  });

  it('a toy that keeps getting lost becomes less liked', () => {
    const w = makeWorld(33);
    const before = w.kinling.learn.data.affinity.rattle;
    for (let i = 0; i < 4; i++) w.kinling.learn.updateAffinity('rattle', 0.1);
    expect(w.kinling.learn.data.affinity.rattle).toBeLessThan(before - 0.1);
  });
});

describe('a cue becomes reliable through practice and feedback', () => {
  it('rewarding sits strengthens the association; later responses are more reliable', () => {
    const w = makeWorld(17);
    familiar(w);
    const k = w.kinling;
    k.learn.data.bond = 0.6;
    const s0 = k.learn.data.cues.sit.strength;
    const outcomes: boolean[] = [];
    for (let trial = 0; trial < 45; trial++) {
      Object.assign(k.needs.values, { nourishment: 0.9, hydration: 0.9, energy: 0.9, stimulation: 0.8, social: 0.6, security: 0.9 });
      if (k.asleep) k.rise();
      k.affect.wariness = 0;
      w.dayTime = 0.5;
      w.cue('sit');
      let correct = false;
      run(w, 7, () => {
        const a = k.brain.activity;
        if (a?.label === 'sit cue: correct' && k.posture === 'sit' && k.settled) correct = true;
        return correct;
      });
      if (correct) {
        // feedback: a few strokes on the head right away
        for (let i = 0; i < 4; i++) { w.touch('head', 'stroke', k.position.x, k.position.y + 0.4, k.position.z); run(w, 0.15); }
      }
      outcomes.push(correct);
      run(w, 9);
    }
    const early = outcomes.slice(0, 15).filter(Boolean).length;
    const late = outcomes.slice(-15).filter(Boolean).length;
    expect(k.learn.data.cues.sit.strength).toBeGreaterThan(s0 + 0.3);
    expect(k.learn.data.cues.sit.rewards).toBeGreaterThan(2);
    expect(late).toBeGreaterThan(early);
  });

  it('an unrewarded response weakens the cue a little', () => {
    const w = makeWorld(17);
    w.kinling.learn.data.cues.sit.strength = 0.6;
    w.kinling.learn.reinforceCue('sit', false);
    expect(w.kinling.learn.data.cues.sit.strength).toBeLessThan(0.6);
    expect(w.kinling.learn.data.cues.sit.strength).toBeGreaterThan(0.5);
  });
});

describe('places and people', () => {
  it('being stroked somewhere makes that place a better place to rest', () => {
    const w = makeWorld(8);
    familiar(w);
    const k = w.kinling;
    k.learn.data.bond = 0.8;
    k.brain.suspended = true;
    k.place(2.4, 3.0, 0);
    const nest = k.learn.data.places[0];
    expect(k.learn.restPlace(2.4, 3.0, 0).label).not.toBe('petting spot');
    for (let day = 0; day < 6; day++) {
      for (let i = 0; i < 12; i++) { w.touch('head', 'stroke', k.position.x, k.position.y + 0.4, k.position.z); run(w, 0.15); }
      run(w, 4);
    }
    const spot = k.learn.data.places.find((p) => p.label === 'petting spot')!;
    expect(spot).toBeDefined();
    expect(spot.comfort).toBeGreaterThan(nest.comfort);
    expect(k.learn.restPlace(2.4, 3.0, 0).label).toBe('petting spot');
    expect(k.learn.data.bond).toBeGreaterThan(0.8);
    expect(k.ltm.recall('pet')).not.toBeNull();
  });

  it('episodic memory consolidates repeats and stays bounded', () => {
    const w = makeWorld(8);
    const m = w.kinling.ltm;
    for (let i = 0; i < 30; i++) m.record({ kind: 'play', subject: 'ball', x: 1, z: 1, t: i * 10, wall: 0, valence: 0.5, note: 'n' });
    expect(m.data.episodes.length).toBe(1);
    expect(m.data.episodes[0].count).toBe(30);
    for (let i = 0; i < 200; i++) m.record({ kind: 'discover', subject: `thing${i}`, x: i % 7, z: 0, t: 1000 + i, wall: 0, valence: 0.1 * (i % 5), note: 'n' });
    expect(m.data.episodes.length).toBeLessThanOrEqual(64);
    const strong = m.data.episodes.find((e) => e.subject === 'ball');
    expect(strong).toBeDefined(); // the well-rehearsed memory outlived the thin ones
    m.decay(3600 * 30);
    const dropped = m.consolidate().dropped;
    expect(dropped).toBeGreaterThan(0);
  });
});

describe('persistence and return', () => {
  it('reloading preserves the individual and its meaningful history', () => {
    const w = makeWorld(77);
    w.identity.name = 'Wren';
    const k = w.kinling;
    w.dropBerry(0.5, -2.5);
    run(w, 45);
    w.tossToy('ball', 2, 2);
    run(w, 30);
    k.learn.reinforceCue('sit', true);
    const json = JSON.stringify(serialize(w, 1_700_000_000_000));
    const data = parseSave(json)!;
    expect(data).not.toBeNull();
    const r = restore(data);
    expect(r.identity.name).toBe('Wren');
    expect(r.identity.seed).toBe(77);
    expect(r.kinling.traits).toEqual(k.traits);
    expect(r.identity.look).toEqual(w.identity.look);
    expect(r.kinling.learn.data).toEqual(k.learn.data);
    expect(r.kinling.ltm.data.episodes.length).toBe(k.ltm.data.episodes.length);
    expect(r.kinling.ltm.lastSeen('ball')).toEqual(k.ltm.lastSeen('ball'));
    for (const n of NEED_KEYS) expect(r.kinling.needs.values[n]).toBeCloseTo(k.needs.values[n], 9);
    expect(r.time).toBeCloseTo(w.time, 6);
    expect(isWalkable(r.kinling.position.x, r.kinling.position.z, 0.1)).toBe(true);
    // and it carries on living
    run(r, 20);
    expect(r.kinling.brain.activity).not.toBeNull();
  });

  it('rejects or repairs damaged saves', () => {
    expect(parseSave('not json')).toBeNull();
    expect(parseSave({})).toBeNull();
    expect(parseSave({ version: 999, identity: { seed: 1 } })).toBeNull();
    const w = makeWorld(5);
    const raw = JSON.parse(JSON.stringify(serialize(w))) as Record<string, any>;
    raw.needs.energy = 'lots';
    raw.needs.hydration = 44;
    raw.kinling.x = 9999;
    raw.learn.bond = null;
    raw.memory.episodes = [{ kind: 'play', x: 'NaN' }, 12, null];
    raw.world.toys.ball = { x: -3.5, y: 0, z: 1.9 }; // in the pond
    const data = parseSave(raw)!;
    expect(data).not.toBeNull();
    expect(data.needs.energy).toBeGreaterThanOrEqual(0);
    expect(data.needs.hydration).toBe(1);
    expect(data.learn.bond).toBeGreaterThan(0);
    expect(data.memory.episodes.length).toBe(1);
    const r = restore(data);
    expect(isWalkable(r.kinling.position.x, r.kinling.position.z, 0.1)).toBe(true);
    expect(isWalkable(r.toys.ball.position.x, r.toys.ball.position.z, 0.05)).toBe(true);
    run(r, 5);
  });

  it('offline progression is bounded and safe for any elapsed time', () => {
    for (const elapsed of [-5000, Number.NaN, Number.POSITIVE_INFINITY, 0, 10, 120, 3600, 86400, 10 * 365 * 86400]) {
      const w = makeWorld(13);
      const k = w.kinling;
      k.needs.values.nourishment = 0.1;
      k.needs.values.energy = 0.1;
      const t0 = w.time;
      const report = applyAbsence(w, elapsed);
      expect(report.credited).toBeLessThanOrEqual(ABSENCE_CAP_S);
      expect(w.time - t0).toBeLessThanOrEqual(ABSENCE_CAP_S + 1e-6);
      for (const n of NEED_KEYS) { expect(k.needs.values[n]).toBeGreaterThanOrEqual(0); expect(k.needs.values[n]).toBeLessThanOrEqual(1); }
      expect(w.dayTime).toBeGreaterThanOrEqual(0); expect(w.dayTime).toBeLessThan(1);
      expect(isWalkable(k.position.x, k.position.z, 0.1)).toBe(true);
      if (!(elapsed >= 45) || !Number.isFinite(elapsed)) expect(report.applied).toBe(false);
      run(w, 10); // still a living, valid creature afterwards
      expect(Number.isFinite(k.position.x)).toBe(true);
    }
  });

  it('a long absence leaves it rested, a little hungry, missing company — and ready to greet', () => {
    const w = makeWorld(13);
    const k = w.kinling;
    k.learn.data.bond = 0.7;
    k.needs.values.energy = 0.1;
    k.needs.values.social = 0.9;
    const report = applyAbsence(w, 5 * 3600);
    expect(report.applied).toBe(true);
    expect(k.needs.values.energy).toBeGreaterThan(0.7);
    expect(k.needs.values.social).toBeLessThan(0.4);
    expect(k.needs.values.nourishment).toBeGreaterThan(0.3);
    expect(w.reunionPending).toBeGreaterThan(0);
    // awake or asleep, it ends up acknowledging the return once it is up
    if (k.asleep) k.rise();
    const log = goalLog(w);
    run(w, 20);
    expect(log.some((l) => l.includes('greet')), log.join('\n')).toBe(true);
  });
});
