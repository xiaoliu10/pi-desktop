import { describe, expect, it } from 'vitest';
import { createBotActions } from '../src/main/pi/bot/actions';

/** /项目 工作区口径：桌面侧栏可见 = 索引会话存在 − hiddenProjects − 副驾/subagent
 *  内部会话。历史教训双钉：只扫历史会话混入已关闭项目；只列活跃 run 滤掉空闲
 *  工作区（开着没在跑 → /项目 只剩一个，用户 2026-10-18 二次反馈）。 */
describe('createBotActions.listProjects 工作区口径', () => {
  const make = (sessions: any[], runs: any[], hiddenProjects?: string[]) =>
    createBotActions(
      { index: { scan: () => sessions }, backend: { runs: () => runs } } as any,
      { preferences: () => ({ hiddenProjects }) } as any,
    );

  const sess = (cwd: string, over: Record<string, unknown> = {}) => ({ key: cwd + '-k', cwd, updatedAt: 1000, ...over });

  it('空闲工作区（无活跃 run、索引有会话）也列出', async () => {
    const actions = make([sess('/w/idle'), sess('/w/busy', { updatedAt: 2000 })], [{ cwd: '/w/busy', timing: { startedAt: Date.now() } }]);
    const projects = await actions.listProjects();
    expect(projects).toContain('/w/idle');
    expect(projects).toContain('/w/busy');
  });

  it('hiddenProjects（已移除项目）不列', async () => {
    const actions = make([sess('/w/kept'), sess('/w/removed')], [], ['/w/removed']);
    expect(await actions.listProjects()).toEqual(['/w/kept']);
  });

  it('副驾与 subagent 内部会话不贡献工作区', async () => {
    const actions = make([sess('/w/main'), sess('/w/side', { sidecarOf: 'x' }), sess('/w/child', { parentSession: 'p' })], []);
    expect(await actions.listProjects()).toEqual(['/w/main']);
  });

  it('排序：活跃 run 的工作区最前，其余按会话活跃时间', async () => {
    const actions = make(
      [sess('/w/old', { updatedAt: 100 }), sess('/w/new', { updatedAt: 900 })],
      [{ cwd: '/w/old', timing: { startedAt: Date.now() } }],
    );
    expect(await actions.listProjects()).toEqual(['/w/old', '/w/new']);
  });

  it('索引抛错 → 退回活跃 run 口径（不空列表）', async () => {
    const actions = createBotActions(
      { index: { scan: () => { throw new Error('boom'); } }, backend: { runs: () => [{ cwd: '/w/run', timing: { startedAt: 1 } }] } } as any,
      { preferences: () => ({}) } as any,
    );
    expect(await actions.listProjects()).toEqual(['/w/run']);
  });
});
