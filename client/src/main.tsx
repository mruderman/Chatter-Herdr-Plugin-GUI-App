import './styles/index.css';
import { render } from 'preact';
import { createThemeManager } from './features/shell';
import { AppRoot, createServices } from './wiring';

// A stored explicit theme goes on <html> before the first render. While the choice is "System" there
// is no attribute and the stylesheet's media queries decide, so only a stored override can show the
// system theme for a moment: index.html cannot carry an inline script (the CSP forbids it).
const themeManager = createThemeManager();
themeManager.start();

const mount = document.getElementById('app');
if (mount) {
  // One store, the Api it shares with the Board, and one notifier, for the life of the page. Nothing
  // disposes them before the page goes: unloading ends the streams and timers with it, and disposing
  // on "pagehide" would leave a page restored from the back-forward cache with a dead store.
  const services = createServices();
  render(<AppRoot services={services} themeManager={themeManager} />, mount);
}
