import { beforeEach, describe, expect, it } from 'vitest';
import type { PiImage } from '../src/shared/composer';

// node 测试环境没有 window/localStorage（adapter 读写偏好需要）
const store = new Map<string, string>();
const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
(globalThis as any).localStorage = ls;
(globalThis as any).window = { innerWidth: 1200, localStorage: ls };

const adapter = await import('../src/renderer/pi/adapter');
const { usePiStore } = adapter;
const { resetComposerDrafts, writeComposerDraftText } = adapter;
const homeKey = (cwd?: string) => (cwd ? `home:${cwd}` : null);
const ownerOf = () => { const st = usePiStore.getState(); return st.selectedKey ?? homeKey(st.draftCwd); };

const imgA: PiImage = { type: 'image', mimeType: 'image/png', data: 'aGk=' };
const docA = { id: 'doc-1', name: '需求.docx', path: '/tmp/需求.docx', kind: 'document' as const, text: '正文' };
const skillA = { id: 'skill-1', name: 'pdf', path: '/skills/pdf/SKILL.md', kind: 'skill' as const, text: '技能内容' };

const seed = () => usePiStore.setState({
  connecting: false, error: undefined, env: { supported: true } as any,
  selectedKey: 'sess-a', draftText: '', contextItems: [], draftCwd: '/tmp/proj',
});

describe('未发送草稿按会话保留（切换不丢）', () => {
  beforeEach(() => {
    resetComposerDrafts();
    usePiStore.setState({ connecting: false, error: undefined, env: { supported: true } as any, draftCwd: '/tmp/proj' });
  });

  it('200ms 防抖窗口内切换：flush 按挂载归属路由，尾字进旧会话草稿', () => {
    seed();
    usePiStore.setState({ draftText: '旧会话已有的' });
    const oldOwner = ownerOf();
    // 模拟 Composer 防抖延迟回调：携带挂载时的 owner，此刻 store 已切到 B 会话
    usePiStore.getState().selectSession('sess-b');
    writeComposerDraftText('旧会话已有的加尾字', oldOwner);
    expect(usePiStore.getState().draftText).toBe(''); // 新会话不被串写
    usePiStore.getState().selectSession('sess-a');
    expect(usePiStore.getState().draftText).toBe('旧会话已有的加尾字'); // 旧归属拿到尾字
  });

  it('同归属导航回放不回滚草稿：编辑后原地 nav 不丢新值', () => {
    seed();
    usePiStore.setState({ draftText: 'v1' });
    usePiStore.getState().selectSession('sess-b');
    usePiStore.getState().selectSession('sess-a'); // 载入 v1
    usePiStore.setState({ draftText: 'v2' }); // 继续编辑
    // 模拟导航回放：switchComposerOwner 同归属（selectSession 到同 key）不得回滚到 v1
    usePiStore.getState().selectSession('sess-a');
    expect(usePiStore.getState().draftText).toBe('v2');
  });
  it('切换会话再切回：文字 + 图片/文件/技能附件原样还原', () => {
    seed();
    usePiStore.setState({ draftText: '还没写完的问题', contextItems: [{ id: 'img-1', name: '图', path: '', kind: 'image', text: '', image: imgA }, docA, skillA] });
    usePiStore.getState().selectSession('sess-b');
    expect(usePiStore.getState().draftText).toBe('');
    expect(usePiStore.getState().contextItems).toEqual([]);
    usePiStore.getState().selectSession('sess-a');
    const s = usePiStore.getState();
    expect(s.draftText).toBe('还没写完的问题');
    expect(s.contextItems).toHaveLength(3);
    expect(s.contextItems[0].image).toEqual(imgA);
    expect(s.contextItems[1].text).toBe('正文');
    expect(s.contextItems[2].kind).toBe('skill');
  });

  it('各会话草稿互不串写：B 会话的内容不会出现在 A', () => {
    seed();
    usePiStore.setState({ draftText: 'A 的草稿', contextItems: [docA] });
    usePiStore.getState().selectSession('sess-b');
    usePiStore.setState({ draftText: 'B 的草稿', contextItems: [] });
    usePiStore.getState().selectSession('sess-a');
    expect(usePiStore.getState().draftText).toBe('A 的草稿');
    expect(usePiStore.getState().contextItems).toEqual([docA]);
  });

  it('空草稿不残留：清空的会话再切回仍是空', () => {
    seed();
    usePiStore.setState({ draftText: '草稿', contextItems: [] });
    usePiStore.getState().selectSession('sess-b');
    usePiStore.getState().selectSession('sess-a');
    usePiStore.setState({ draftText: '', contextItems: [] });
    usePiStore.getState().selectSession('sess-b');
    usePiStore.getState().selectSession('sess-a');
    expect(usePiStore.getState().draftText).toBe('');
  });

  it('开新任务：当前会话草稿转存，新任务框按 cwd 恢复自己的草稿', () => {
    seed();
    usePiStore.setState({ draftText: '会话里的草稿', contextItems: [] });
    usePiStore.getState().startNewSession();
    expect(usePiStore.getState().draftText).toBe(''); // home:/tmp/proj 无草稿
    usePiStore.setState({ draftText: '新任务草稿', contextItems: [docA] });
    usePiStore.getState().selectSession('sess-a');
    expect(usePiStore.getState().draftText).toBe('会话里的草稿'); // 会话草稿回来了
    usePiStore.getState().startNewSession();
    expect(usePiStore.getState().draftText).toBe('新任务草稿'); // 新任务草稿按 cwd 回来了
    expect(usePiStore.getState().contextItems).toEqual([docA]);
  });

  it('发送成功后该会话的草稿转存被清除（重进是空输入框）', () => {
    seed();
    usePiStore.setState({ draftText: '将要发送', contextItems: [docA] });
    // 模拟发送成功的清空路径（send 内同步清空 + 清除归属草稿）
    usePiStore.getState().setDraftText('');
    usePiStore.setState({ contextItems: [] });
    usePiStore.getState().selectSession('sess-b');
    usePiStore.getState().selectSession('sess-a');
    expect(usePiStore.getState().draftText).toBe('');
    expect(usePiStore.getState().contextItems).toEqual([]);
  });
});
