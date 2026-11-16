/**
 * Developer inspector: a live view of the agent's actual decision inputs —
 * what it perceives, what it needs, how every evaluator scored and why, the
 * active goal stack, body state, navigation and what it has learned.
 * Technical diagnostics live here and nowhere else in the interface.
 */
import * as THREE from 'three';
import { TRAIT_KEYS } from '../sim/identity';
import { NEED_KEYS } from '../sim/needs';
import { Senses } from '../sim/creature/senses';
import { heightAt } from '../sim/terrain';
import type { World } from '../sim/world';

export interface PerfInfo { fps: number; frameMs: number; steps: number; quality: string; tris: number; calls: number }

export class Inspector {
  readonly el: HTMLElement;
  open = false;
  private timer = 0;
  private events: string[] = [];
  private pathLine: THREE.Line;

  constructor(root: HTMLElement, private world: World, scene: THREE.Scene) {
    this.el = document.createElement('div');
    this.el.className = 'inspector';
    this.el.setAttribute('aria-label', 'Developer inspector');
    root.append(this.el);
    const log = (s: string): void => { this.events.push(`${world.time.toFixed(0)}s ${s}`); if (this.events.length > 14) this.events.shift(); };
    world.events.on('learn', (e) => log(`learn · ${e.text}`));
    world.events.on('memory', (e) => log(`memory · ${e.text}`));
    world.events.on('cue', (e) => log(`cue · ${e.kind} → ${e.response}${e.detail ? ` (${e.detail})` : ''}`));
    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf0b45a, depthTest: false, transparent: true, opacity: 0.8 }));
    this.pathLine.renderOrder = 20;
    this.pathLine.visible = false;
    this.pathLine.frustumCulled = false;
    scene.add(this.pathLine);
  }

  toggle(): void {
    this.open = !this.open;
    this.el.classList.toggle('open', this.open);
    this.pathLine.visible = this.open;
    this.timer = 0;
  }

  update(dt: number, perf: PerfInfo): void {
    if (!this.open) return;
    if ((this.timer -= dt) > 0) return;
    this.timer = 0.25;
    const k = this.world.kinling;
    const f = (v: number, d = 2): string => v.toFixed(d);
    const bar = (label: string, v: number, note = ''): string => `<div class="bar"><span>${label}</span><i><b style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%"></b></i><span>${note || f(v)}</span></div>`;
    const b = k.brain;
    const evals = [...b.evaluators].sort((x, y) => y.final - x.final);
    const rows = evals.map((e) => {
      const cd = b.cooldownLeft(e);
      const terms = e.terms.map((t) => `${t.name} ${f(t.value)}`).join(' · ');
      return `<tr class="${e === b.current ? 'win' : ''}"><td>${e.name}</td><td>${f(e.final)}</td><td class="dim">×${f(e.characterBias)}</td><td class="terms">${cd > 0 ? `cooldown ${f(cd, 0)}s` : terms}</td></tr>`;
    }).join('');
    const percepts = k.senses.current().map((r) => {
      const e = r.entity!;
      return `<tr><td>${Senses.describe(e)}</td><td>${r.visible ? 'in view' : 'remembered'}</td><td class="dim">${f(k.now - r.timeLastSensed, 1)}s ago</td><td class="dim">${f(r.lastSensedPosition.distanceTo(k.position), 1)}m · true ${f(e.position.distanceTo(k.position), 1)}m</td></tr>`;
    }).join('') || '<tr><td class="dim">nothing in short-term memory</td></tr>';
    const L = k.learn.data;
    const kv = (o: Record<string, number>): string => Object.entries(o).map(([key, v]) => `${key} ${f(v)}`).join(' · ') || '—';
    const hab = Object.entries(L.habituation).map(([key, v]) => `${key} ${f(k.learn.habituation(key, k.now))}(n${v.n})`).join(' · ') || '—';
    this.el.innerHTML = `
      <h4>Frame</h4>
      <div>${f(perf.fps, 0)} fps · ${f(perf.frameMs, 1)} ms · sim steps ${perf.steps} · quality ${perf.quality} · ${Math.round(perf.tris / 1000)}k tris · ${perf.calls} calls</div>
      <div class="dim">lived ${f(k.now, 0)}s · day ${f(this.world.dayTime)} · night ${f(this.world.night)}</div>
      <h4>Needs</h4>${NEED_KEYS.map((n) => bar(n, k.needs.values[n], `${f(k.needs.values[n])}`)).join('')}
      <h4>Affect</h4>
      ${bar('valence', (k.affect.valence + 1) / 2, f(k.affect.valence))}${bar('arousal', k.affect.arousal)}${bar('wariness', k.affect.wariness)}${bar('interest', k.affect.interest)}
      <h4>Personality (seed ${k.identity.seed})</h4>
      ${TRAIT_KEYS.map((t) => bar(t, k.traits[t], `${f(k.identity.traits[t])}${L.traitShift[t] >= 0 ? '+' : ''}${f(L.traitShift[t], 3)}`)).join('')}
      <h4>Body</h4>
      <div>mode ${k.mode} · posture ${k.posture} · ${k.action ? `action ${k.action.kind} ${f(k.action.t, 1)}/${f(k.action.duration, 1)}s` : 'no action'}${k.startle.phase !== 'none' ? ` · startle ${k.startle.phase}` : ''}</div>
      <div class="dim">style ${k.style} · speed ${f(k.speed)} · carrying ${k.carrying?.kind ?? '—'} · alert ${f(k.alert)} · glow ${f(k.glow)}</div>
      <h4>Intention</h4>
      <div>${b.activity ? `${b.activity.label} — ${b.activity.phase}` : '—'} <span class="dim">commit ${f(Math.max(0, b.commitLeft), 1)}s</span></div>
      <div class="dim">subgoals: ${b.activity?.describe().join(' → ') || '—'}</div>
      ${b.pendingCue ? `<div>pending cue: ${b.pendingCue.kind} → ${b.pendingCue.response} in ${f(Math.max(0, b.pendingCue.readyAt - k.now), 1)}s</div>` : ''}
      <h4>Goal scores (desirability × character bias)</h4>
      <table>${rows}</table>
      <h4>Perception (what it knows, not world truth)</h4>
      <table>${percepts}</table>
      <h4>Navigation</h4>
      <div>${k.travel.kind}${k.travel.dest ? ` → (${f(k.travel.dest.x, 1)}, ${f(k.travel.dest.z, 1)}) · ${f(k.distanceTo(k.travel.dest.x, k.travel.dest.z), 1)}m` : ''}${k.travel.path ? ` · ${k.travel.path.length} waypoints` : ''}${k.stuckT > 0 ? ` · stuck ${f(k.stuckT, 1)}s` : ''}</div>
      <h4>Learned</h4>
      <div>liking: ${kv(L.affinity)}</div>
      <div>cues: come ${f(L.cues.come.strength)} (${L.cues.come.rewards}/${L.cues.come.trials}) · sit ${f(L.cues.sit.strength)} (${L.cues.sit.rewards}/${L.cues.sit.trials})</div>
      <div>bond ${f(L.bond)} · familiarity: ${kv(L.familiarity)}</div>
      <div>habituation: ${hab}</div>
      <div>places: ${L.places.map((p) => `${p.label} ${f(p.comfort)}`).join(' · ')}</div>
      <div class="dim">episodes ${k.ltm.data.episodes.length} · ${k.ltm.recent(3).map((e) => `${e.kind}:${e.subject}(${f(e.salience)})`).join(' ')}</div>
      <h4>Recent decisions</h4>
      ${b.history.slice(-6).reverse().map((h) => `<div>${f(h.t, 0)}s ${h.name} <span class="dim">${h.reason}</span></div>`).join('')}
      <h4>Learning &amp; memory events</h4>
      ${this.events.slice().reverse().map((e) => `<div class="dim">${e}</div>`).join('') || '<div class="dim">—</div>'}`;
    // planned path, drawn in the world
    const path = k.travel.path;
    if (path && path.length > 1) {
      const pts = path.map((p) => new THREE.Vector3(p.x, heightAt(p.x, p.z) + 0.05, p.z));
      this.pathLine.geometry.setFromPoints(pts);
      this.pathLine.visible = true;
    } else this.pathLine.visible = false;
  }
}
