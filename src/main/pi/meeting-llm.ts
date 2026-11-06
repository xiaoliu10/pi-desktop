import { Worker } from 'node:worker_threads';
import path from 'node:path';

/**
 * 纪要在独立 Node utility worker 中调用 pi ModelRuntime.completeSimple。
 * 没有 AgentSession、工具、写盘 agent；只有单条 prompt → assistant text。
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let settled = false;
let timer;
function send(payload) { if (settled) return; settled = true; clearTimeout(timer); try { parentPort.postMessage(payload); } catch {} }
function fail(message) { send({ ok: false, error: String(message || '纪要生成失败') }); }
(async () => {
  const cli = workerData.cli;
  if (typeof cli !== 'string' || !cli.endsWith('.js') || !fs.existsSync(cli)) throw new Error('无法定位 pi runtime');
  const sdk = path.join(path.dirname(cli), '..', 'index.js');
  const mod = await import(pathToFileURL(sdk).href);
  const runtime = await mod.ModelRuntime.create({
    authPath: path.join(workerData.agentDir, 'auth.json'),
    modelsPath: path.join(workerData.agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  const model = runtime.getModel(workerData.provider, workerData.model);
  if (!model) throw new Error('模型 ' + workerData.provider + '/' + workerData.model + ' 不存在');
  const message = { role: 'user', content: [{ type: 'text', text: workerData.prompt }], timestamp: Date.now() };
  const result = await runtime.completeSimple(model, { messages: [message] }, { maxTokens: 8192 });
  if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage || '模型调用失败');
  const text = Array.isArray(result.content)
    ? result.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('').trim()
    : typeof result.content === 'string' ? result.content.trim() : '';
  if (!text) throw new Error('模型没有返回文本');
  send({ ok: true, text });
})().catch(error => fail(error?.message || error));
timer = setTimeout(() => fail('纪要生成超时'), workerData.timeoutMs || 240000);
timer.unref?.();
`;

export interface MeetingLlmInput {
  cli: string;
  agentDir: string;
  prompt: string;
  provider: string;
  model: string;
  timeoutMs?: number;
}

export async function runMeetingLlm(input: MeetingLlmInput): Promise<string> {
  if (typeof input.prompt !== 'string' || input.prompt.length < 1) throw new Error('纪要 prompt 为空');
  if (input.prompt.length > 400_000) throw new Error('纪要单块过大');
  return await new Promise<string>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { ...input, timeoutMs: input.timeoutMs ?? 240_000 },
      env: { ...process.env, PI_CODING_AGENT_DIR: input.agentDir },
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    });
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; fn(); };
    worker.once('message', (message: { ok?: boolean; text?: string; error?: string }) => {
      finish(() => {
        if (message?.ok && typeof message.text === 'string' && message.text.trim()) resolve(message.text.trim());
        else reject(new Error(String(message?.error || '纪要生成失败')));
      });
    });
    worker.once('error', error => finish(() => reject(error)));
    worker.once('exit', code => finish(() => reject(new Error(code === 0 ? '纪要 worker 未返回结果' : `纪要 worker 退出 (${code})`))));
  });
}
