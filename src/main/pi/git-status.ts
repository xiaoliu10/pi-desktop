import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitStatus } from '../../shared/conversation-status';
const exec = promisify(execFile);
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const result: GitStatus = {root: cwd, repository:false, branch:'', branches:[], added:0,removed:0,changed:0,untracked:0,binary:0,ahead:0,behind:0};
  const run = async (args: string[]) => (await exec('git', ['-c','core.fsmonitor=false', ...args], {cwd, timeout:10000, maxBuffer:4*1024*1024, env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;
  try { result.root = (await run(['rev-parse','--show-toplevel'])).trim(); }
  catch { return result; }
  result.repository = true;
  try {
    let base = 'HEAD';
    try { await run(['rev-parse','--verify','HEAD']); } catch { base='4b825dc642cb6eb9a060e54bf8d69288fbee4904'; }
    const [status, stats, branches] = await Promise.all([
      run(['status','--porcelain=v2','--branch','--untracked-files=all','-z','--','.']),
      run(['diff','--no-ext-diff','--no-textconv','--numstat','-z',base,'--','.']),
      run(['for-each-ref','--format=%(refname:short)','refs/heads/']),
    ]);
    const records=status.split('\0');
    for(let i=0;i<records.length;i++) {
      const row=records[i];
      if(row.startsWith('# branch.head ')) result.branch=row.slice(14);
      else if(row.startsWith('# branch.ab ')) { const m=row.match(/\+(\d+) -(\d+)/); if(m){result.ahead=Number(m[1]);result.behind=Number(m[2]);} }
      else if(row.startsWith('? ')) result.untracked++;
      else if(/^[12u] /.test(row)) {result.changed++; if(row.startsWith('2 ')) i++;}
    }
    const chunks=stats.split('\0');
    for(let i=0;i<chunks.length;i++) {
      const m=chunks[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/); if(!m) continue;
      if(m[1]==='-') result.binary++; else {result.added+=Number(m[1]);result.removed+=Number(m[2]);}
      if(m[3]==='') i+=2; // -z rename has two following path fields
    }
    result.branches=branches.trim().split('\n').filter(Boolean);
    return result;
  } catch(e) { return {...result,error:`Git 状态读取失败：${(e as Error).message}`}; }
}
