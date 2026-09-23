// PI Desktop subagent fallback adapter
// Loads ONLY when no third-party subagent extension is detected at launch time.
// Provides the official pi subagent extension with Desktop permission enforcement.
// Progress persistence is handled at the main-process RPC event layer (not here).
import official from "/Users/jason/projects/opensource/pi-desktop/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts";
import fs from 'node:fs';

export default function(pi) {
  official({...pi, registerTool(tool) {
    pi.registerTool({...tool, async execute(...args) {
      // Desktop permission gate: the official subagent spawns an unsupervised
      // pi subprocess, so per-mode Desktop approval is insufficient.
      let mode = process.env.PI_DESKTOP_PERMISSION;
      try { if (process.env.PI_DESKTOP_MODE_FILE) mode = fs.readFileSync(process.env.PI_DESKTOP_MODE_FILE, 'utf8').trim(); } catch {}
      if (mode && mode !== 'fullAccess') {
        throw new Error('官方 subagent 插件的子进程不支持 Desktop 独立审批。请使用完全访问模式，或使用设置中的独立会话。');
      }
      const controller = new AbortController();
      const parent = args[2];
      args[2] = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      const timer = setInterval(() => {
        try { if (process.env.PI_DESKTOP_MODE_FILE && fs.readFileSync(process.env.PI_DESKTOP_MODE_FILE, 'utf8').trim() !== 'fullAccess') controller.abort(); } catch { controller.abort(); }
      }, 250);
      try { return await tool.execute(...args); }
      finally { clearInterval(timer); }
    }});
  }});
}
