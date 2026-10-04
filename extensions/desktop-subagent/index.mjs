// PI Desktop subagent fallback adapter
// Loads ONLY when no third-party subagent extension is detected at launch time.
// Provides the official pi subagent extension with Desktop permission enforcement.
// Progress persistence is handled at the main-process RPC event layer (not here).
import official from "/Users/jason/projects/opensource/pi-desktop/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts";
import fs from 'node:fs';

// 失败停滞宽限：子代理 details 已全部终态且存在失败，但工具迟迟不返回时，
// 等这么久就主动终止等待（结果已定，剩余的只是挂住的收尾）。
const STALL_GRACE_MS = 10_000;

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
      // 失败停滞看门狗：官方扩展的子 pi 进程以 "close" 事件收尾，若子进程启动的
      // 孙进程继承了 stdio 管道，close 可能长期不触发——工具不返回、end 事件不发，
      // 对话流的工具卡片永挂「运行中」，主 agent 也被卡死。而子代理的失败状态
      // 早已经由 onUpdate 的 details 实时可见（stopReason=error/aborted）。
      // 这里包装 onUpdate 检测「全部子代理已终态且存在失败」，宽限后从包装层
      // 抛出（并 abort 清理子进程），让 pi 正常发出 tool_execution_end(isError)，
      // 前端卡片与子代理面板恢复一致。
      let stallReject;
      if (typeof args[3] === 'function') {
        const original = args[3];
        let failedSince;
        const isFinished = (r) => r && typeof r === 'object' && r.stopReason !== undefined;
        const isFailed = (r) => r && (r.stopReason === 'error' || r.stopReason === 'aborted');
        args[3] = (u) => {
          try {
            const results = u?.details?.results;
            if (Array.isArray(results) && results.length > 0) {
              if (results.every(isFinished) && results.some(isFailed)) {
                if (!failedSince) failedSince = Date.now();
              } else failedSince = undefined;
              if (failedSince && Date.now() - failedSince > STALL_GRACE_MS && stallReject) {
                failedSince = undefined;
                controller.abort(); // 杀掉残留子进程，防止后台继续消耗
                stallReject(new Error(`子代理已失败但未正常返回（收尾挂起超过 ${STALL_GRACE_MS / 1000} 秒），已由桌面端终止等待。`));
              }
            }
          } catch { /* 看门狗自身的解析失败不影响原始 update 透传 */ }
          return original(u);
        };
      }
      const stallPromise = new Promise((_, reject) => { stallReject = reject; });
      stallPromise.catch(() => {}); // 无 race 时避免 unhandled rejection
      const timer = setInterval(() => {
        try { if (process.env.PI_DESKTOP_MODE_FILE && fs.readFileSync(process.env.PI_DESKTOP_MODE_FILE, 'utf8').trim() !== 'fullAccess') controller.abort(); } catch { controller.abort(); }
      }, 250);
      try { return await Promise.race([tool.execute(...args), stallPromise]); }
      finally { clearInterval(timer); }
    }});
  }});
}
