/**
 * The interface: a name plate with a one-line reading of the creature, a
 * dock of tools, a settings sheet and a small journal. Deliberately quiet —
 * the creature's body language carries the information; this only names it.
 */
import type { Tool } from '../input/pointer';
import type { Settings } from '../persistence/storage';

const svg = (d: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS: Record<string, string> = {
  hand: svg('<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5V5a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V14c0 3.6-2.4 6.5-6 6.5-2.6 0-4-1.2-5.4-3.6L4 14.2a1.4 1.4 0 0 1 2.3-1.5L8 14.5"/>'),
  berry: svg('<circle cx="9" cy="15" r="4.2"/><circle cx="15.5" cy="13" r="3.6"/><path d="M12 9c.5-2.5 2-4 4.5-4.5M12 9c-1-1.6-2.6-2.4-4.6-2.3"/>'),
  ball: svg('<circle cx="12" cy="12" r="7.5"/><path d="M5.2 9.5c4 1.4 9.6 1.4 13.6 0M5.2 14.5c4-1.4 9.6-1.4 13.6 0M12 4.5v15"/>'),
  rattle: svg('<circle cx="9.5" cy="9.5" r="5.5"/><path d="m13.6 13.6 6 6M7 8.5c1.5 1 3.5 1 5 0M7.5 11.5c1.3.7 2.7.7 4 0"/>'),
  wisp: svg('<circle cx="12" cy="11" r="2.6"/><path d="M12 3.5v2M12 16.5v4M4.5 11h2M17.5 11h2M6.8 5.8l1.4 1.4M15.8 14.8l1.4 1.4M17.2 5.8l-1.4 1.4M8.2 14.8l-1.4 1.4"/>'),
  curio: svg('<path d="M12 20.5c-4.4 0-7-2.6-7-6 0-4.6 3.4-9.5 7-11 3.6 1.5 7 6.4 7 11 0 3.4-2.6 6-7 6Z"/><path d="M12 16a2.5 2.5 0 1 0-2.5-2.5"/>'),
  call: svg('<path d="M4.5 10.5h7l6-4v11l-6-4h-7z"/><path d="M19.5 9.5c.8.7 1.2 1.5 1.2 2.5s-.4 1.8-1.2 2.5M7.5 13.5v4.5h3v-4.5"/>'),
  spin: svg('<path d="M7 7a7 7 0 1 1-1.9 7M7 3.5V8h4.5"/><path d="M10 13a2.2 2.2 0 1 0 3-2"/>'),
  sit: svg('<path d="M6 19c0-4 1-6.5 3-8.5V6.5l2.2 1.6c2.6-.3 5 .6 6.3 2.9 1 1.8 1.2 4.6.5 8z"/><path d="M6 19h12.5"/>'),
  sound: svg('<path d="M4.5 9.5h3.5l4.5-3.5v12L8 14.5H4.5z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.4 7.4 0 0 1 0 10.4"/>'),
  mute: svg('<path d="M4.5 9.5h3.5l4.5-3.5v12L8 14.5H4.5z"/><path d="m16 9.5 4.5 5M20.5 9.5 16 14.5"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3.8v2.4M12 17.8v2.4M3.8 12h2.4M17.8 12h2.4M6.2 6.2l1.7 1.7M16.1 16.1l1.7 1.7M17.8 6.2l-1.7 1.7M7.9 16.1l-1.7 1.7"/>'),
};

const TOOLS: Array<{ id: Tool; label: string; key: string; hint: string }> = [
  { id: 'hand', label: 'Hand', key: '1', hint: 'Stroke, tap and pick things up' },
  { id: 'berry', label: 'Berry', key: '2', hint: 'Click the ground to drop a berry' },
  { id: 'ball', label: 'Ball', key: '3', hint: 'Click the ground to toss the ball there' },
  { id: 'rattle', label: 'Rattle', key: '4', hint: 'Click the ground to toss the rattle there' },
  { id: 'wisp', label: 'Wisp', key: '5', hint: 'Lead a wisp of light across the ground' },
  { id: 'curio', label: 'Curio', key: '6', hint: 'Click the ground to set down something new' },
];

export interface HudHooks {
  tool(tool: Tool): void;
  call(): void;
  cueSit(): void;
  cueSpin(): void;
  settings(change: Partial<Settings>): void;
  name(name: string): void;
  exportSave(): void;
  importSave(file: File): void;
  reset(): void;
  toggleInspector(): void;
  journal(): JournalData;
  gesture(): void;
}

export interface JournalData {
  name: string;
  age: string;
  nature: string[];
  likes: string[];
  learning: string[];
  memories: Array<{ text: string; when: string }>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export class Hud {
  private veil: HTMLElement;
  private nameEl: HTMLElement;
  private moodEl: HTMLElement;
  private toastEl: HTMLElement;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private soundBtn: HTMLButtonElement;
  private sheet: HTMLElement;
  private journal: HTMLElement;
  private naming: HTMLElement | null = null;
  private toastTimer = 0;
  private toastQueue: Array<{ text: string; ms: number }> = [];
  private toastBusy = false;

  constructor(private root: HTMLElement, private hooks: HudHooks, private settings: Settings) {
    this.veil = el('div', { class: 'veil', role: 'status' }, '<div><h1>Kinling</h1><p>waking the glade…</p><div class="ember"></div></div>');
    root.append(this.veil);

    const plate = el('button', { class: 'plate', 'aria-label': 'Open the journal', 'aria-expanded': 'false' });
    this.nameEl = el('div', { class: 'name' });
    this.moodEl = el('div', { class: 'mood', 'aria-live': 'polite' });
    plate.append(this.nameEl, this.moodEl);
    plate.addEventListener('click', () => this.toggleJournal());
    root.append(plate);

    const corner = el('div', { class: 'corner' });
    this.soundBtn = el('button', { class: 'round', 'aria-label': 'Sound on or off', title: 'Sound (M)' }, ICONS.sound);
    this.soundBtn.addEventListener('click', () => { hooks.gesture(); this.change({ muted: !this.settings.muted }); });
    const gear = el('button', { class: 'round', 'aria-label': 'Settings', title: 'Settings' }, ICONS.gear);
    gear.addEventListener('click', () => { this.sheet.classList.toggle('open'); this.journal.classList.remove('open'); });
    corner.append(this.soundBtn, gear);
    root.append(corner);

    const dock = el('div', { class: 'dock', role: 'toolbar', 'aria-label': 'Ways to interact' });
    for (const t of TOOLS) {
      const b = el('button', { class: 'tool', 'aria-pressed': 'false', 'aria-label': `${t.label}: ${t.hint}`, title: `${t.hint} (${t.key})` }, `${ICONS[t.id]}<span>${t.label}</span><kbd>${t.key}</kbd>`);
      b.addEventListener('click', () => { hooks.gesture(); hooks.tool(t.id); });
      this.toolButtons.set(t.id, b);
      dock.append(b);
    }
    dock.append(el('div', { class: 'sep', role: 'separator' }));
    const call = el('button', { class: 'tool act', 'aria-label': 'Call: whistle for it to come', title: 'Whistle for it to come (C)' }, `${ICONS.call}<span>Call</span><kbd>C</kbd>`);
    call.addEventListener('click', () => { hooks.gesture(); hooks.call(); });
    const sit = el('button', { class: 'tool act', 'aria-label': 'Sit cue: practise a cue; reward it when it sits', title: 'Give the "sit" cue — reward it with a stroke or a berry when it sits (S)' }, `${ICONS.sit}<span>Sit</span><kbd>S</kbd>`);
    sit.addEventListener('click', () => { hooks.gesture(); hooks.cueSit(); });
    const spin = el('button', { class: 'tool act', 'aria-label': 'Spin cue: reward a twirl', title: 'Teach a spin (T)' }, `${ICONS.spin}<span>Spin</span><kbd>T</kbd>`);
    spin.addEventListener('click', () => { hooks.gesture(); hooks.cueSpin(); });
    dock.append(call, sit, spin);
    root.append(dock);

    this.toastEl = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    root.append(this.toastEl);

    this.sheet = this.buildSheet();
    this.journal = el('div', { class: 'card journal', role: 'dialog', 'aria-label': 'Journal' });
    root.append(this.sheet, this.journal);
    this.applySettings();
  }

  private change(c: Partial<Settings>): void {
    Object.assign(this.settings, c);
    this.hooks.settings(c);
    this.applySettings();
  }

  private applySettings(): void {
    this.soundBtn.innerHTML = this.settings.muted ? ICONS.mute : ICONS.sound;
    this.soundBtn.classList.toggle('off', this.settings.muted);
    this.soundBtn.setAttribute('aria-pressed', String(!this.settings.muted));
    const q = <T extends HTMLElement>(s: string): T => this.sheet.querySelector(s) as T;
    q<HTMLInputElement>('#set-volume').value = String(Math.round(this.settings.volume * 100));
    q<HTMLInputElement>('#set-mute').checked = this.settings.muted;
    q<HTMLInputElement>('#set-motion').checked = this.settings.reducedMotion;
    q<HTMLSelectElement>('#set-quality').value = this.settings.quality;
  }

  private buildSheet(): HTMLElement {
    const s = el('div', { class: 'card sheet', role: 'dialog', 'aria-label': 'Settings' });
    s.innerHTML = `
      <h3>Sound</h3>
      <div class="field"><label for="set-volume">Volume</label><input id="set-volume" type="range" min="0" max="100" step="1"></div>
      <div class="field"><label for="set-mute">Mute</label><input id="set-mute" type="checkbox"></div>
      <details class="note"><summary>Wildlife sound credits</summary>
        <p><a href="https://commons.wikimedia.org/wiki/File:European_Robin_(Erithacus_rubecula)_(W1CDR0001425_BD16).ogg" target="_blank" rel="noreferrer">Robin song</a> by Lawrence Shove, © The British Library Board · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>. Trimmed and level-adjusted.</p>
        <p><a href="https://commons.wikimedia.org/wiki/File:Single_Frog_Croak.oga" target="_blank" rel="noreferrer">Single Frog Croak</a> by MichaeltheFox8621 · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>. Trimmed and level-adjusted.</p>
      </details>
      <h3>Comfort</h3>
      <div class="field"><label for="set-motion">Reduced motion</label><input id="set-motion" type="checkbox"></div>
      <div class="field"><label for="set-quality">Detail</label>
        <select id="set-quality"><option value="auto">Automatic</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
      <h3>Your kinling</h3>
      <div class="stack">
        <button class="btn quiet" id="set-export">Export save</button>
        <button class="btn quiet" id="set-import">Import save</button>
        <button class="btn danger" id="set-reset">Start over</button>
      </div>
      <input id="set-file" type="file" accept="application/json,.json" hidden>
      <p class="note">Saved in this browser. Nothing runs while the page is closed; when you return, the time away is estimated and applied.</p>
      <h3>Controls</h3>
      <p class="note" style="margin-top:0">Drag the ground to look around, scroll or pinch to zoom. Drag across the creature to stroke it. Drag a toy to pick it up and flick to throw. Arrow keys turn the view, + and − zoom.</p>
      <div class="stack" style="margin-top:12px"><button class="btn quiet" id="set-dev">Developer inspector (\`)</button></div>`;
    const q = <T extends HTMLElement>(sel: string): T => s.querySelector(sel) as T;
    q<HTMLInputElement>('#set-volume').addEventListener('input', (e) => { this.hooks.gesture(); this.change({ volume: Number((e.target as HTMLInputElement).value) / 100 }); });
    q<HTMLInputElement>('#set-mute').addEventListener('change', (e) => this.change({ muted: (e.target as HTMLInputElement).checked }));
    q<HTMLInputElement>('#set-motion').addEventListener('change', (e) => this.change({ reducedMotion: (e.target as HTMLInputElement).checked }));
    q<HTMLSelectElement>('#set-quality').addEventListener('change', (e) => this.change({ quality: (e.target as HTMLSelectElement).value as Settings['quality'] }));
    q('#set-export').addEventListener('click', () => this.hooks.exportSave());
    const file = q<HTMLInputElement>('#set-file');
    q('#set-import').addEventListener('click', () => file.click());
    file.addEventListener('change', () => { const f = file.files?.[0]; if (f) this.hooks.importSave(f); file.value = ''; });
    let armed = 0;
    const reset = q<HTMLButtonElement>('#set-reset');
    reset.addEventListener('click', () => {
      if (Date.now() - armed < 4000) { this.hooks.reset(); return; }
      armed = Date.now();
      reset.textContent = 'Really? Click again';
      setTimeout(() => { reset.textContent = 'Start over'; }, 4000);
    });
    q('#set-dev').addEventListener('click', () => { this.hooks.toggleInspector(); this.sheet.classList.remove('open'); });
    return s;
  }

  private toggleJournal(): void {
    const open = !this.journal.classList.contains('open');
    this.sheet.classList.remove('open');
    this.journal.classList.toggle('open', open);
    if (!open) return;
    const j = this.hooks.journal();
    const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const list = (items: string[]): string => (items.length ? `<div class="chips">${items.map((i) => `<span class="chip">${esc(i)}</span>`).join('')}</div>` : '<p>Still finding out.</p>');
    this.journal.innerHTML = `
      <h2>${esc(j.name)}</h2><p>${esc(j.age)}</p>
      <div class="row" style="margin-bottom:14px"><input type="text" id="j-name" maxlength="24" aria-label="Name" value="${esc(j.name)}"><button class="btn quiet" id="j-save">Rename</button></div>
      <h3 class="sr">Nature</h3>${list(j.nature)}
      <h3 class="sr" style="margin-top:12px">Likes</h3>${list(j.likes)}
      <h3 class="sr" style="margin-top:12px">Learning</h3>${list(j.learning)}
      <h3 class="sr" style="margin-top:12px">Remembers</h3>
      <ul>${j.memories.map((m) => `<li>${esc(m.text)}<small>${esc(m.when)}</small></li>`).join('') || '<li>Nothing much yet.</li>'}</ul>`;
    for (const h of this.journal.querySelectorAll<HTMLElement>('h3.sr')) Object.assign(h.style, { font: '600 11.5px var(--body)', letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--muted)', margin: h.style.marginTop ? `${h.style.marginTop} 0 6px` : '0 0 6px' });
    const input = this.journal.querySelector<HTMLInputElement>('#j-name')!;
    const save = (): void => { const v = input.value.trim(); if (v) { this.hooks.name(v); this.setName(v); } };
    this.journal.querySelector('#j-save')!.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); e.stopPropagation(); });
  }

  closePanels(): void {
    this.sheet.classList.remove('open');
    this.journal.classList.remove('open');
  }

  ready(): void {
    this.veil.classList.add('gone');
    setTimeout(() => this.veil.remove(), 1400);
  }

  setTool(tool: Tool): void {
    for (const [id, b] of this.toolButtons) b.setAttribute('aria-pressed', String(id === tool));
  }
  setName(name: string): void {
    this.nameEl.textContent = name || 'A kinling';
    document.title = name ? `${name} · Kinling` : 'Kinling';
  }
  setMood(text: string): void {
    if (this.moodEl.textContent !== text) this.moodEl.textContent = text;
  }

  /** Queue a short message; they show one at a time. */
  toast(text: string, ms = 4200): void {
    if (this.toastQueue.some((t) => t.text === text) || this.toastEl.textContent === text && this.toastBusy) return;
    this.toastQueue.push({ text, ms });
    if (!this.toastBusy) this.nextToast();
  }
  private nextToast(): void {
    const next = this.toastQueue.shift();
    if (!next) { this.toastBusy = false; return; }
    this.toastBusy = true;
    this.toastEl.textContent = next.text;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('show');
      this.toastTimer = window.setTimeout(() => this.nextToast(), 600);
    }, next.ms);
  }

  /** The gentle first-meeting prompt. Never blocks the view or the creature. */
  askName(suggestion: string, done: (name: string) => void): void {
    if (this.naming) return;
    const card = el('div', { class: 'card naming', role: 'dialog', 'aria-label': 'Name your kinling' });
    card.innerHTML = `<h2>Someone lives here</h2><p>A kinling has made its home in your glade. What will you call it?</p>
      <div class="row"><input type="text" maxlength="24" aria-label="Name" value="${suggestion}"><button class="btn">Name it</button></div>
      <div class="row" style="margin-top:10px"><button class="btn quiet" data-later>Decide later</button></div>`;
    this.naming = card;
    this.root.append(card);
    requestAnimationFrame(() => card.classList.add('show'));
    const input = card.querySelector('input')!;
    const finish = (name: string): void => {
      card.classList.remove('show');
      setTimeout(() => card.remove(), 700);
      done(name);
    };
    card.querySelector('.btn')!.addEventListener('click', () => finish(input.value.trim() || suggestion));
    card.querySelector('[data-later]')!.addEventListener('click', () => finish(''));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || suggestion); e.stopPropagation(); });
  }
}
