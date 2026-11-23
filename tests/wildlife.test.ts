import { describe, expect, it } from 'vitest';
import { parseSave, restore, serialize } from '../src/sim/save';
import { makeWorld, run } from './helpers';

describe('glade wildlife', () => {
  it('shows a trail, waits for the player, and remembers the longest completed chorus', () => {
    const world = makeWorld(), w = world.wildlife;
    w.startChorus();
    const trail = [...w.sequence];
    expect(trail).toHaveLength(2);
    w.choosePad(trail[0]);
    run(world, 5);
    expect(w.frogMode).toBe('answer');
    w.choosePad(trail[0]);
    w.choosePad(trail[1]);
    expect(w.cursor).toBe(1);
    run(world, .6);
    w.choosePad(trail[1]);
    expect(w.frogMode).toBe('won');
    expect(w.progress.best).toBe(2);
    run(world, .6);
    w.startChorus();
    expect(w.sequence).toHaveLength(3);
    run(world, 6);
    w.choosePad((w.sequence[0] + 1) % 3);
    expect(w.frogMode).toBe('miss');
    const retry = [...w.sequence];
    w.startChorus();
    expect(w.sequence).toEqual(retry);
    run(world, 7);
    expect(w.frogMode).toBe('answer');
    w.leaveChorus();
    expect(w.frogMode).toBe('resting');
    expect(w.progress.best).toBe(2);
    expect(restore(parseSave(serialize(world))!).wildlife.progress.best).toBe(2);
  });

  it('earns trust on actual meals, visits the kinling, and answers a whistle', () => {
    const world = makeWorld(), w = world.wildlife;
    for (let i = 0; i < 3; i++) {
      w.scatter(); w.scatter();
      expect(w.progress.meals).toBe(i);
      run(world, 9, () => w.progress.meals > i);
      expect(w.progress.meals).toBe(i + 1);
      if (i === 2) expect(w.robinMode).toBe('visiting');
      run(world, 6, () => w.robinMode === 'perched');
    }
    const calls: string[] = [];
    world.events.on('wildlifeCall', e => calls.push(e.species));
    w.whistle();
    run(world, 1);
    expect(w.progress.replies).toBe(1);
    expect(calls).toContain('robin');
  });

  it('upgrades existing saves and bounds malformed progress', () => {
    const save = serialize(makeWorld());
    delete save.world.wildlife;
    Reflect.deleteProperty(save.learn.cues, 'spin');
    expect(restore(parseSave(save)!).kinling.learn.data.cues.spin.strength).toBeGreaterThan(0);
    expect(restore(parseSave(save)!).wildlife.progress).toEqual({ meals: 0, replies: 0, best: 0 });
    save.world.wildlife = { meals: -3, replies: 4.6, best: 55 };
    expect(parseSave(save)?.world.wildlife).toEqual({ meals: 0, replies: 4, best: 6 });
  });
});

it('reinforces a completed spin when the player strokes the kinling', () => {
  const world = makeWorld(7), k = world.kinling;
  k.learn.data.cues.spin.strength = .95;
  world.setPlayerSpot(k.position.x, k.position.z + .5);
  // Even a well-learned cue can receive a puzzled response.
  for (let attempt = 0; attempt < 5 && k.action?.kind !== 'spin'; attempt++) {
    world.cue('spin');
    run(world, 7, () => k.action?.kind === 'spin' && k.brain.activity?.label === 'spin cue: correct');
  }
  expect(k.action?.kind).toBe('spin');
  run(world, 1.6);
  world.touch('head', 'stroke', k.position.x, k.position.y + .4, k.position.z);
  run(world, 2);
  expect(k.learn.data.cues.spin.rewards).toBe(1);
  expect(k.learn.data.cues.sit.rewards).toBe(0);
  expect(restore(parseSave(serialize(world))!).kinling.learn.data.cues.spin.rewards).toBe(1);
});
