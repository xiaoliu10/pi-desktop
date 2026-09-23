import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { PiRpcClient } from '../src/main/pi/rpc-client';
const clients:PiRpcClient[]=[];
const client=()=>{const c=new PiRpcClient(process.execPath,[path.resolve('tests/fixtures/fake-pi.mjs')],process.cwd(),process.env);clients.push(c);return c;};
afterEach(()=>clients.splice(0).forEach(c=>c.close()));
describe('pi RPC framing and lifecycle',()=>{
 it('correlates out-of-order replies',async()=>{const c=client();expect(await Promise.all([c.request('echo',{value:'first',delay:40}),c.request('echo',{value:'second'})])).toEqual(['first','second']);});
 it('preserves UTF-8 and Unicode line separators',async()=>expect(await client().request('unicode')).toBe('中文\u2028\u2029'));
 it('ignores non-protocol stdout without failing valid replies',async()=>expect(await client().request('noise')).toBe('fine'));
 it('rejects command errors and times out without replay',async()=>{const c=client();await expect(c.request('bad')).rejects.toThrow('unsupported');await expect(c.request('never',{},50)).rejects.toThrow('超时');});
 it('settles every pending promise when process exits',async()=>{const c=client();const waiting=c.request('never');const exiting=c.request('exit');await expect(waiting).rejects.toThrow('退出');await expect(exiting).rejects.toThrow('退出');});
});
