import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import 'highlight.js/styles/github-dark.css';

/**
 * Two explicit entries:
 *  - default: the real app (requires the Electron preload bridge)
 *  - ?preview=1: the UI replica preview with demo data (no window.pi access)
 * The normal entry never falls back to fake data.
 */

const params = new URLSearchParams(window.location.search);
const root = createRoot(document.getElementById('root')!);

if (params.get('preview') === '1') {
  void import('./preview/PreviewApp').then(({ PreviewApp }) => {
    root.render(<PreviewApp />);
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
