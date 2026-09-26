import { describe, expect, it } from 'vitest';
import type { PiImage } from '../src/shared/composer';

// node 测试环境没有 window/localStorage（adapter 读写偏好需要）
const store = new Map<string, string>();
const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
(globalThis as any).localStorage = ls;
(globalThis as any).window = { innerWidth: 1200, localStorage: ls };

const { usePiStore } = await import('../src/renderer/pi/adapter');

const imgA: PiImage = { type: 'image', mimeType: 'image/png', data: 'aGk=' };

const runWith = (queue: any[]) => ({
  key: 'run-1', generation: 'g1', status: 'running', cwd: '/tmp/proj', file: '/tmp/s.jsonl',
  accessMode: 'ask', executionMode: 'ask', models: [], commands: [], pending: queue.length, queue,
});
const seed = (queue: any[]) => usePiStore.setState({
  connecting: false, error: undefined, env: { supported: true } as any,
  selectedKey: 'run-1', runs: [runWith(queue) as any], draftText: '', contextItems: [], pendingSteer: undefined,
});
const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise(r => setTimeout(r, 5)); };

describe('queueRecall: queued prompt (text + images) back into the composer', () => {
  it('recalls a synced queued item with its images into composer chips and removes it from the queue', async () => {
    const calls: any[] = [];
    (globalThis as any).window.localPi = { queueEdit: async (...a: any[]) => { calls.push(a); } };
    seed([{ text: '看看这张图', behavior: 'followUp', images: [imgA] }]);
    usePiStore.getState().queueRecall(0);
    // 文字进草稿，图片进附件 chips（ContextChips 据此渲染缩略图/双击预览）
    expect(usePiStore.getState().draftText).toBe('看看这张图');
    const items = usePiStore.getState().contextItems;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('image');
    expect(items[0].image).toEqual(imgA);
    // 乐观移除 + 后端 remove 调用
    expect(usePiStore.getState().runs[0].queue).toHaveLength(0);
    expect(calls[0][1]).toEqual({ type: 'remove', index: 0 });
  });

  it('recalls an optimistic (pendingSync) queued item with images', async () => {
    const calls: any[] = [];
    (globalThis as any).window.localPi = { queueEdit: async (...a: any[]) => { calls.push(a); } };
    seed([{ text: '还没同步的排队', behavior: 'followUp', images: [imgA], pendingSync: true }]);
    usePiStore.getState().queueRecall(0);
    expect(usePiStore.getState().draftText).toBe('还没同步的排队');
    expect(usePiStore.getState().contextItems[0]?.image).toEqual(imgA);
    expect(calls[0][1]).toEqual({ type: 'remove', index: 0 });
  });

  it('restores the original queue and keeps the draft/images when the backend remove fails', async () => {
    (globalThis as any).window.localPi = { queueEdit: async () => { throw new Error('队列项不存在'); } };
    const item = { text: '看看这张图', behavior: 'followUp' as const, images: [imgA] };
    seed([item]);
    usePiStore.getState().queueRecall(0);
    await until(() => usePiStore.getState().runs[0].queue?.length === 1);
    expect(usePiStore.getState().runs[0].queue![0]).toEqual(item); // 原队列恢复
    expect(usePiStore.getState().draftText).toBe('看看这张图');    // 草稿不丢
    expect(usePiStore.getState().contextItems[0]?.image).toEqual(imgA);
    expect(usePiStore.getState().error).toContain('队列项不存在');
  });

  it('re-send after recall carries the recalled images again', async () => {
    const promptCalls: any[] = [];
    (globalThis as any).window.localPi = {
      queueEdit: async () => {},
      prompt: async (...a: any[]) => { promptCalls.push(a); },
    };
    seed([{ text: '看看这张图', behavior: 'followUp', images: [imgA] }]);
    usePiStore.getState().queueRecall(0);
    await until(() => usePiStore.getState().contextItems.length === 1);
    usePiStore.getState().send('看看这张图（改）');
    await until(() => promptCalls.length === 1);
    // prompt(key, text, behavior, images)：图片随重发一起带出
    expect(promptCalls[0][1]).toContain('看看这张图（改）');
    expect(promptCalls[0][3]).toEqual([imgA]);
    // 乐观入队项也带图（缩略图立即渲染，不等 queue_update）
    const queue = usePiStore.getState().runs[0].queue!;
    expect(queue.at(-1)?.images).toEqual([imgA]);
    expect(queue.at(-1)?.pendingSync).toBe(true);
  });
});
