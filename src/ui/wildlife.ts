import { PAD_NAMES, type Subject, type Wildlife } from '../sim/wildlife';

interface Hooks {
  watch(subject: Subject): void;
  scatter(): void;
  whistle(): void;
  chorus(): void;
  pad(index: number): void;
}

/** The same flowers can be played on the pond, by touch, or from these keyboard-focusable controls. */
export class WildlifeHud {
  private tabs = new Map<Subject, HTMLButtonElement>();
  private panel = document.createElement('section');
  private title = document.createElement('strong');
  private status = document.createElement('span');
  private actions = document.createElement('div');
  private progress = document.createElement('small');
  private buttons: HTMLButtonElement[] = [];
  subject: Subject = 'kinling';

  constructor(private root: HTMLElement, private hooks: Hooks) {
    const nav = document.createElement('nav');
    nav.className = 'animals';
    nav.setAttribute('aria-label', 'Watch an animal');
    for (const [id, name] of [['kinling', 'Kinling'], ['robin', 'Robin'], ['frog', 'Frog']] as const) {
      const b = document.createElement('button');
      b.textContent = name;
      b.setAttribute('aria-pressed', String(id === this.subject));
      b.addEventListener('click', () => hooks.watch(id));
      this.tabs.set(id, b);
      nav.append(b);
    }
    this.panel.className = 'wild-panel';
    this.panel.hidden = true;
    this.status.setAttribute('role', 'status');
    this.actions.className = 'wild-actions';
    const header = document.createElement('header');
    header.append(this.title, this.progress);
    this.panel.append(header, this.status, this.actions);
    root.append(nav, this.panel);
  }

  select(subject: Subject): void {
    this.subject = subject;
    this.root.classList.toggle('watching', subject !== 'kinling');
    this.panel.hidden = subject === 'kinling';
    this.actions.replaceChildren();
    this.buttons = [];
    for (const [id, b] of this.tabs) b.setAttribute('aria-pressed', String(id === subject));
    if (subject === 'kinling') return;
    this.title.textContent = subject === 'robin' ? 'Glade robin' : 'Pond chorus';
    if (subject === 'robin') {
      this.button('Scatter seed', this.hooks.scatter);
      this.button('Whistle', this.hooks.whistle);
    } else {
      this.button('Start chorus', this.hooks.chorus);
      PAD_NAMES.forEach((name, i) => this.button(name, () => this.hooks.pad(i)));
    }
  }

  private button(label: string, action: () => void): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', action);
    this.buttons.push(b);
    this.actions.append(b);
  }

  update(w: Wildlife): void {
    if (this.subject === 'kinling') return;
    let message: string, progress: string;
    if (this.subject === 'robin') {
      const phrases = {
        perched: 'Scatter seeds on the ground, or whistle for a reply.',
        watching: 'Watching the seeds. Give it a moment…',
        foraging: 'Gliding down to forage.',
        pecking: 'Pecking between the blades of grass.',
        visiting: 'It trusts you enough to visit your kinling.',
        returning: 'Fluttering back to its perch.',
        singing: 'Listening for your whistle…',
        replying: 'Singing back to you.',
      };
      message = phrases[w.robinMode];
      progress = w.progress.meals < 3 ? `Trust · ${w.progress.meals}/3 meals` : `Befriended · ${w.progress.replies} replies`;
      this.buttons[0].disabled = !!w.seeds || w.robinMode === 'pecking' || w.robinMode === 'visiting';
      this.buttons[1].disabled = w.robinMode !== 'perched';
    } else {
      const modes = {
        resting: 'Watch the frog, then repeat its flower trail.',
        showing: w.flash < 0 ? 'Watch the flowers…' : `Watch · ${PAD_NAMES[w.flash]}`,
        answer: `Your turn · flower ${w.cursor + 1} of ${w.sequence.length}`,
        won: `In harmony! All ${w.sequence.length} flowers matched.`,
        miss: `The next flower was ${PAD_NAMES[w.sequence[w.cursor]]}. Replay to try again.`,
      };
      message = modes[w.frogMode];
      progress = `Longest trail · ${w.progress.best}`;
      const label = w.frogMode === 'answer' || w.frogMode === 'miss' ? 'Replay trail' : w.frogMode === 'won' ? 'Next trail' : 'Start chorus';
      if (this.buttons[0].textContent !== label) this.buttons[0].textContent = label;
      this.buttons[0].disabled = !!w.frog.trip || w.frogMode === 'showing';
      for (let i = 0; i < PAD_NAMES.length; i++) {
        this.buttons[i + 1].disabled = w.frogMode !== 'answer' || !!w.frog.trip;
        this.buttons[i + 1].classList.toggle('lit', w.flash === i);
      }
    }
    if (this.status.textContent !== message) this.status.textContent = message;
    if (this.progress.textContent !== progress) this.progress.textContent = progress;
  }
}
