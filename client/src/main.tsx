import { render } from 'preact';

// Exported so the toolchain test can render it without a #app element; replaced when the real shell lands.
export function Placeholder() {
  return (
    <main>
      <h1>Chatter</h1>
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<Placeholder />, root);
