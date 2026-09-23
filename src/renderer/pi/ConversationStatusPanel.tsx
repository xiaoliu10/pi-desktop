import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../replica/Icons';
import type { ChatMessage } from '../replica/contracts';
import type { GitStatus } from '../../shared/conversation-status';
import type { PiSessionStats } from '../../shared/pi';
import { conversationPlan } from './conversation-plan';
import './conversation-status.css';

/** 1234→1.2k, 1234567→1.23M —— 状态栏紧凑数字。 */
const fmtTokens = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

export function ConversationStatusPanel({cwd,messages,running,stats,onReview,onRequest,onOpenPlan,planAvailable}: {
  cwd?:string; messages:ChatMessage[]; running:boolean; stats?:PiSessionStats; onReview:()=>void; onRequest:(text:string)=>void;
  /** 计划查看器入口（ZCode 状态面板 sessionPlans 区的同位复刻）。 */
  onOpenPlan?:()=>void; planAvailable?:boolean;
}) {
  const [git,setGit]=useState<GitStatus>();
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const [collapsed,setCollapsed]=useState(()=>localStorage.getItem('pi-status-collapsed')==='true' || window.innerWidth<760);
  const [expanded,setExpanded]=useState(false);
  const [menu,setMenu]=useState(false);
  const plan=useMemo(()=>conversationPlan(messages),[messages]);
  useEffect(()=>{
    let cancelled=false, timer:ReturnType<typeof setTimeout>;
    setGit(undefined); setError('');
    const refresh=async()=>{
      try { if(cwd){const next=await window.localPi!.gitStatus(cwd); if(!cancelled){setGit(next);setError(next.error||'');}} }
      catch(e){if(!cancelled)setError(String((e as Error).message||e));}
      finally {if(!cancelled)timer=setTimeout(refresh,running?3000:10000);}
    };
    void refresh();
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[cwd,running,revision]);
  const toggle=()=>setCollapsed(value=>{localStorage.setItem('pi-status-collapsed',String(!value));return !value;});
  return <aside className={`pi-status-rail ${collapsed?'is-collapsed':''} ${expanded?'is-expanded':''}`} aria-label="会话状态面板">
    <section className="pi-status-card">
      <header>
        <button onClick={toggle} aria-expanded={!collapsed}><span>{git?.repository?'Git 工具':'任务状态'}</span><Icon name={collapsed?'chevron-right':'chevron-down'} size={12}/></button>
        <button aria-label="状态面板菜单" aria-expanded={menu} onClick={()=>setMenu(!menu)}><Icon name="more" size={16}/></button>
        <button aria-label={expanded?'缩小状态面板':'展开状态面板'} onClick={()=>{setExpanded(!expanded);setCollapsed(false);}}><Icon name="expand-diagonal" size={14}/></button>
      </header>
      {menu&&<div className="pi-status-menu"><button onClick={()=>{setRevision(r=>r+1);setMenu(false);}}><Icon name="refresh" size={13}/>刷新状态</button><button onClick={()=>{toggle();setMenu(false);}}>折叠 / 展开</button></div>}
      {!collapsed&&<>
        {git?.repository&&<div className="pi-status-git">
          <button className="pi-status-row" onClick={onReview} title="查看相对 HEAD 的项目变更；行数不含未跟踪文件和二进制文件">
            <Icon name="file-plus" size={15}/><span>更改</span><span className="pi-status-count"><b>+{git.added}</b><em>−{git.removed}</em></span>
          </button>
          {(git.untracked>0||git.binary>0)&&<small>{git.untracked>0?`${git.untracked} 个未跟踪文件`:''}{git.binary>0?` · ${git.binary} 个二进制变更`:''}</small>}
          <details className="pi-status-branches"><summary><Icon name="git-branch" size={15}/><span>{git.branch==='(detached)'?'分离 HEAD':git.branch||'未创建分支'}</span><Icon name="chevron-down" size={12}/></summary><div><small>本地分支 · 点击准备切换请求</small>{git.branches.map(branch=><button key={branch} disabled={branch===git.branch} onClick={()=>onRequest(`请检查当前工作区，保留未提交改动，然后切换到本地 Git 分支 ${JSON.stringify(branch)}。若存在冲突先向我说明。`)}>{branch}{branch===git.branch?' ✓':''}</button>)}</div></details>
          {(git.ahead>0||git.behind>0)&&<small>领先 {git.ahead} · 落后 {git.behind}</small>}
          <button className="pi-status-row" onClick={()=>onRequest('请先检查并展示当前项目的 Git 变更，帮我准备提交或推送。确认提交范围、提交说明及推送目标后，等待我确认再执行。')} title="在输入框准备提交或推送请求，由你发送"><Icon name="git-commit" size={15}/><span>提交或推送</span></button>
        </div>}
        {!git&&!error&&cwd&&<p className="pi-status-hint">正在读取 Git 状态…</p>}
        {git&&!git.repository&&<p className="pi-status-hint">当前目录不是 Git 仓库</p>}
        {error&&<p className="pi-status-error" role="status">{error}</p>}
        {stats&&stats.tokens.total>0&&<div className="pi-status-stats">
          <div className="pi-status-plan-head"><span>会话统计</span><b>{fmtTokens(stats.tokens.total)} tokens</b></div>
          <div className="pi-status-statgrid">
            <div><small>输入</small><b>{fmtTokens(stats.tokens.input)}</b></div>
            <div><small>输出</small><b>{fmtTokens(stats.tokens.output)}</b></div>
            <div><small>缓存</small><b>{fmtTokens(stats.tokens.cacheRead + stats.tokens.cacheWrite)}</b></div>
            {stats.cost!==undefined&&Number.isFinite(stats.cost)&&<div><small>费用</small><b>${stats.cost<0.01&&stats.cost>0?stats.cost.toFixed(4):stats.cost.toFixed(2)}</b></div>}
            {stats.totalMessages!==undefined&&<div><small>消息</small><b>{stats.totalMessages}</b></div>}
            {stats.toolCalls!==undefined&&<div><small>工具调用</small><b>{stats.toolCalls}</b></div>}
          </div>
        </div>}
        <div className="pi-status-plan">
          <div className="pi-status-plan-head"><span>进程</span>{planAvailable&&onOpenPlan&&<button className="pi-status-plan-open" onClick={onOpenPlan} title="在右侧查看计划全文"><Icon name="book" size={12}/>查看计划</button>}<b>{plan.filter(item=>item.status==='completed').length}/{plan.length}</b></div>
          {!plan.length&&<p className="pi-status-hint">Agent 创建任务清单后，进度会显示在这里。</p>}
          <ol>{plan.map((item,index)=><li key={index} className={`is-${item.status}`}><Icon name={item.status==='completed'?'check-circle':item.status==='in_progress'?'refresh':'circle'} size={13}/><span>{item.step}</span><span className="pi-status-sr">{item.status==='completed'?'已完成':item.status==='in_progress'?'进行中':'待处理'}</span></li>)}</ol>
        </div>
      </>}
    </section>
  </aside>;
}
