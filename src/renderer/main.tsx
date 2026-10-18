import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installPerfProbe, installPerfGlobals } from './perf-probe';
import './styles.css';

/**
 * Two explicit entries:
 *  - default: the real app (requires the Electron preload bridge)
 *  - ?preview=1: the UI replica preview with demo data (no window.pi access)
 * The normal entry never falls back to fake data.
 */

installPerfProbe();
installPerfGlobals();
// 调试埋点出口：Composer 重渲染计数（打字卡顿量化用，见 perf-probe.ts 同源说明）
void import('./replica/chat/ChatView').then(m => { (window as any).__piComposerRenders = () => m.composerRenderCount.n; });

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
