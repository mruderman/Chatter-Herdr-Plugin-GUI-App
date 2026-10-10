import './styles/index.css';
import { render } from 'preact';
import { App } from './app';
import { createThemeManager, useTheme } from './features/shell';

// A stored explicit theme goes on <html> before the first render. While the choice is "System" there
// is no attribute and the stylesheet's media queries decide, so only a stored override can show the
// system theme for a moment: index.html cannot carry an inline script (the CSP forbids it).
const themeManager = createThemeManager();
themeManager.start();

// The store is not connected yet, so the session is unknown: the page shows its pending state.
// The integration task replaces this with the real session, repos and connection.
function Root() {
  const theme = useTheme(themeManager);
  return <App session={{ status: 'unknown' }} themeChoice={theme.choice} onThemeChange={theme.setChoice} />;
}

const mount = document.getElementById('app');
if (mount) render(<Root />, mount);
