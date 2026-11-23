/** Plain-language account of who this Kinling has turned out to be. No numbers. */
import { favouriteTouch, type TraitKey } from '../sim/identity';
import { describeGap } from '../sim/offline';
import type { World } from '../sim/world';
import type { JournalData } from '../ui/hud';

const WORDS: Record<TraitKey, [string, string]> = {
  curiosity: ['inquisitive', 'likes what it knows'],
  sociability: ['affectionate', 'independent'],
  confidence: ['bold', 'cautious'],
  playfulness: ['playful', 'easy-going'],
  persistence: ['determined', 'easily distracted'],
  sensitivity: ['easily startled', 'unflappable'],
};

export function buildJournal(world: World, now = Date.now()): JournalData {
  const k = world.kinling;
  const L = k.learn.data;
  const nature: string[] = [];
  for (const key of Object.keys(WORDS) as TraitKey[]) {
    const v = k.traits[key];
    if (v > 0.6) nature.push(WORDS[key][0]);
    else if (v < 0.4) nature.push(WORDS[key][1]);
  }
  if (nature.length === 0) nature.push('even-tempered');
  const likes: string[] = [];
  const played = (['ball', 'rattle', 'wisp'] as const).filter((a) => L.plays[a] > 0).sort((a, b) => L.affinity[b] - L.affinity[a]);
  if (played.length && L.affinity[played[0]] > 0.5) likes.push(`the ${played[0]}`);
  if (played.length > 1 && L.affinity[played[played.length - 1]] < 0.4) likes.push(`not so keen on the ${played[played.length - 1]}`);
  if (k.stats.pets > 2) likes.push(`being stroked on the ${favouriteTouch(k.identity)}`);
  const place = k.learn.favouritePlace();
  if (place.visits > 0) likes.push(`resting at the ${place.label}`);
  const learning: string[] = [];
  const how = (s: number): string => (s > 0.8 ? 'reliably' : s > 0.55 ? 'usually' : s > 0.3 ? 'sometimes' : s > 0.12 ? 'now and then' : 'not yet');
  if (L.cues.come.trials > 0) learning.push(`comes when called: ${how(L.cues.come.strength)}`);
  if (L.cues.spin.trials > 0) learning.push(`spins on cue: ${how(L.cues.spin.strength)}`);
  if (L.cues.sit.trials > 0) learning.push(`sits on cue: ${how(L.cues.sit.strength)}`);
  learning.push(L.bond > 0.7 ? 'trusts you completely' : L.bond > 0.45 ? 'trusts you' : L.bond > 0.28 ? 'getting to know you' : 'still wary of you');
  const used = Object.entries(L.habituation).filter(([, v]) => v.h > 0.5).map(([key]) => key);
  if (used.includes('chime')) learning.push('no longer minds the chime');
  const memories = [...k.ltm.data.episodes]
    .filter((e) => e.salience > 0.12)
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 5)
    .map((e) => ({ text: e.note.charAt(0).toUpperCase() + e.note.slice(1) + (e.count > 2 ? ' (often)' : ''), when: `${describeGap(Math.max(0, (now - e.wall) / 1000))} ago` }));
  const age = Math.max(0, (now - k.identity.bornAt) / 1000);
  return { name: k.identity.name || 'A kinling', age: `You met ${describeGap(age)} ago.`, nature, likes, learning, memories };
}
