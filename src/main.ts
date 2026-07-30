/**
 * Entry point: mount the HUD markup, start the engine, wire the two together.
 *
 * This is the only file that knows about both halves. The engine emits events;
 * the HUD reacts. In Phase 3 the `hudMarkup` injection below becomes
 * `createRoot(ui).render(<App game={game} />)` and nothing in `src/engine`
 * changes at all.
 */

import hudMarkup from './ui/hud.html?raw';
import './ui/hud.css';

import { Game } from './engine/game';
import { starterDesign } from './engine/ship/design';
import { createHud } from './ui/hud';

const stage = document.getElementById('stage');
const ui = document.getElementById('ui');
if (!stage || !ui) throw new Error('index.html is missing #stage or #ui');

ui.innerHTML = hudMarkup;

const game = new Game(stage, {
  onModeChange: (mode) => hud.setMode(mode),
  onResult: (result) => hud.showResult(result),
  onDesignChange: (design) => hud.refreshShipReport(design),
});

const hud = createHud(game);

// ── shipyard buttons ──
document.getElementById('resetBtn')?.addEventListener('click', () => {
  game.setDesign(starterDesign());
});
document.getElementById('clearBtn')?.addEventListener('click', () => {
  game.setDesign(new Map());
});
document.getElementById('sailBtn')?.addEventListener('click', () => {
  game.enterBattle();
});
document.getElementById('rebuildBtn')?.addEventListener('click', () => {
  game.enterBuild();
});
document.getElementById('rematchBtn')?.addEventListener('click', () => {
  game.enterBuild();
  game.enterBattle();
});

game.start();

// Give the first frame a moment to land before revealing the scene.
setTimeout(() => {
  const loader = document.getElementById('loader');
  if (loader) loader.style.display = 'none';
}, 350);
