/**
 * 扩展源码编辑器 / 新建扩展对话框（插件市场统一管理的落点）：
 * 与设置页原「扩展」资源管理同一套后端 API（resourceRead/resourceSave/resourceCreate），
 * 但入口收拢到侧边栏「插件市场」——设置页只保留跳转，不再重复展示资源列表。
 * 新建：范围（全局/项目）+ 名称 + 模板源码；编辑：resource 行由调用方传入（含 editable/path），
 * 读盘带 revision，保存前版本检查并备份。
 */

import { useEffect, useRef, useState } from 'react';
import './plugins.css';

export function extensionTemplate(name: string): string {
  return `export default function(pi) {\n  pi.registerCommand('${name}', {\n    description: '我的扩展命令',\n    handler: async (_args, ctx) => { ctx.ui.notify('扩展已运行'); }\n  });\n}\n`;
}

export type ExtensionDialogInit = { mode: 'create' } | { mode: 'edit'; id: string };

export function ExtensionSourceDialog(props: {
  init: ExtensionDialogInit;
  /** 编辑模式的目标资源摘要（调用方从资源列表按 id 找出；missing 状态视作只读）。 */
  resource?: { name: string; path: string; editable: boolean };
  projects: Array<{ path: string; name: string }>;
  onClose: () => void;
  /** 保存/创建成功（含提示文案），调用方负责刷新资源列表。 */
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const api = () => window.localPi;
  const creating = props.init.mode === 'create';
  const resource = props.resource;
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [project, setProject] = useState('');
  const [name, setName] = useState('my-extension');
  const [text, setText] = useState(() => extensionTemplate('my-extension'));
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    if (!creating && props.init.mode === 'edit') {
      let active = true;
      api().resourceRead(props.init.id).then((doc) => {
        if (!active) return;
        setRevision(doc.revision);
        setText(doc.text);
      }).catch((e) => { props.onError(String(e)); props.onClose(); });
      return () => { active = false; };
    }
  }, [creating]);

  const save = async () => {
    setBusy(true);
    try {
      if (creating) {
        await api().resourceCreate({ kind: 'extensions', scope, name: name.trim(), text, cwd: scope === 'project' ? project : undefined });
        props.onSaved('扩展已创建；重载会话后生效');
      } else if (resource) {
        await api().resourceSave({ id: props.init.mode === 'edit' ? props.init.id : '', text, revision });
        props.onSaved('扩展已保存；请重载运行中的会话');
      }
    } catch (e) {
      props.onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pi-exteditor" role="dialog" aria-modal="true" aria-label={creating ? '新建扩展' : '编辑扩展源码'} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="pi-exteditor__card" ref={ref} tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); } }}>
        <header className="pi-exteditor__head">
          <h2>{creating ? '新建扩展' : resource?.name || '编辑扩展源码'}</h2>
          <button type="button" className="pi-iconbtn" aria-label="关闭" onClick={props.onClose}>×</button>
        </header>
        {!creating && resource && <code className="pi-exteditor__path">{resource.path}{!resource.editable && '（只读）'}</code>}
        {creating && (
          <div className="pi-exteditor__fields">
            <label>范围
              <select value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'project')}>
                <option value="user">全局</option>
                <option value="project" disabled={!props.projects.length}>当前项目</option>
              </select>
            </label>
            {scope === 'project' && (
              <label>项目
                <select value={project} onChange={(e) => setProject(e.target.value)}>
                  <option value="">选择项目…</option>
                  {props.projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
                </select>
              </label>
            )}
            <label>名称
              <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            </label>
          </div>
        )}
        <textarea
          className="pi-exteditor__code"
          rows={14}
          spellCheck={false}
          aria-label="扩展源码"
          readOnly={!creating && !resource?.editable}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="pi-exteditor__hint">
          {creating ? '扩展将作为本地代码执行，请审阅源码后再创建；保存到 ' : '保存前检查磁盘版本，并为原文件生成备份。'}
          {creating && (scope === 'project' ? (project || '…') + '/.pi/extensions/' : '~/.pi/agent/extensions/')}
        </p>
        <div className="pi-exteditor__actions">
          <button type="button" className="pi-btn pi-btn--primary" disabled={busy || (!creating && !resource?.editable) || (creating && scope === 'project' && !project) || (creating && !name.trim())} onClick={() => void save()}>
            {creating ? '创建文件' : '保存内容'}
          </button>
          <button type="button" className="pi-btn pi-btn--outline" onClick={props.onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
