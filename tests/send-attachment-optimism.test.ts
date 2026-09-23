import { describe, expect, it } from 'vitest';

// node 测试环境没有 window/localStorage（adapter 读写偏好需要）
const store = new Map<string, string>();
const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
(globalThis as any).localStorage = ls;
(globalThis as any).window = { innerWidth: 1200, localStorage: ls };

const { usePiStore } = await import('../src/renderer/pi/adapter');

const imageItem = { id: 'img1', name: '截图.png', path: '', kind: 'image' as const, text: '', image: { type: 'image' as const, mimeType: 'image/png', data: 'aGk=' } };

const seed = () => usePiStore.setState({
  connecting: false, pendingPrompt: undefined, error: undefined, sentAt: undefined,
  env: { supported: true } as any,
  selectedKey: 'src-key', runs: [], draftText: '', contextItems: [imageItem],
});

const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise(r => setTimeout(r, 5)); };

describe('send: attachments move with the text, restore on failure', () => {
  it('clears attachment chips optimistically while sending, restores them when prompt fails', async () => {
    let fail = true;
    const promptCalls: any[] = [];
    (globalThis as any).window.localPi = {
      connect: async () => ({ key: 'run-1', generation: 'g1', status: 'starting', cwd: '/tmp/proj', file: '/tmp/s.jsonl', accessMode: 'ask', executionMode: 'ask', models: [], commands: [], pending: 0 }),
      prompt: async (...args: any[]) => { promptCalls.push(args); if (fail) throw new Error('pi 已退出 (1)'); },
      history: async () => ({ leaves: [], branch: [] }),
      sessions: async () => [],
    };
    seed();
    usePiStore.getState().send('看这张图');
    // 乐观阶段：文字进气泡的同时，附件 chips 也要立即清空，不能只剩图片挂在输入框
    expect(usePiStore.getState().contextItems).toHaveLength(0);
    expect(usePiStore.getState().draftText).toBe('');
    await until(() => !usePiStore.getState().connecting);
    // 失败恢复：草稿与附件一并回来
    expect(usePiStore.getState().draftText).toBe('看这张图');
    expect(usePiStore.getState().contextItems).toHaveLength(1);
    expect(usePiStore.getState().error).toContain('pi 已退出');
    expect(usePiStore.getState().pendingPrompt).toBeUndefined();
    // 图片随 prompt 一并发送
    expect(promptCalls[0][3]).toEqual([imageItem.image]);
  });

  it('keeps attachments cleared when prompt succeeds', async () => {
    const promptCalls: any[] = [];
    (globalThis as any).window.localPi = {
      connect: async () => ({ key: 'run-1', generation: 'g1', status: 'starting', cwd: '/tmp/proj', file: '/tmp/s.jsonl', accessMode: 'ask', executionMode: 'ask', models: [], commands: [], pending: 0 }),
      prompt: async (...args: any[]) => { promptCalls.push(args); },
      history: async () => ({ leaves: [], branch: [] }),
      sessions: async () => [],
    };
    seed();
    usePiStore.getState().send('看这张图');
    await until(() => !usePiStore.getState().connecting);
    expect(usePiStore.getState().contextItems).toHaveLength(0);
    expect(usePiStore.getState().error).toBeUndefined();
    expect(promptCalls[0][1]).toContain('看这张图');
  });
});
