import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/figtree';
import './ui/styles.css';
import { App } from './app/App';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const app = new App(canvas, ui);
(window as unknown as { __kinling: App }).__kinling = app;
app.start().then(() => { (window as unknown as { __ready: boolean }).__ready = true; }).catch((err) => {
  console.error(err);
  ui.innerHTML = '<div class="veil"><div><h1>Kinling</h1><p>This browser could not start the glade (WebGL 2 is required).</p></div></div>';
});
