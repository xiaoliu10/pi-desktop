/**
 * Electron <webview> 标签的 JSX 类型声明。
 * 安全约束（与 src/main/index.ts 的 web-contents-created 守卫配套）：
 * 只允许 src；绝不挂 preload / nodeintegration / webpreferences / allowpopups，
 * 保证任意网页拿不到主窗口的 window.localPi 本地 IPC 能力。
 */

import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}
