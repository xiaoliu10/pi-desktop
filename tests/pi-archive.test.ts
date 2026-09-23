import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { SessionArchive } from '../src/main/pi/session-archive';
import { usePiStore } from '../src/renderer/pi/adapter';
const roots:string[]=[];
afterEach(()=>{roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true}));vi.unstubAllGlobals();});
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-archive-'));roots.push(root);const file=path.join(root,'metadata/archive.json');return {root,file,archive:new SessionArchive(file)};}
it('persists archive and restore without modifying native session files',()=>{
 const {root,file,archive}=setup();const session=path.join(root,'session.jsonl');fs.writeFileSync(session,'native session content');
 expect(archive.list()).toEqual([]);archive.set('key',true);archive.set('key',true);
 expect(new SessionArchive(file).list()).toEqual(['key']);
 expect(fs.readFileSync(session,'utf8')).toBe('native session content');
 expect(archive.set('key',false)).toEqual([]);expect(new SessionArchive(file).list()).toEqual([]);
});
it('refuses to archive busy tasks and does not overwrite a damaged index',()=>{
 const {file,archive}=setup();expect(()=>archive.set('key',true,true)).toThrow('仍在运行');expect(fs.existsSync(file)).toBe(false);
 archive.set('one',true);fs.writeFileSync(file,'{"unexpected":true}');
 expect(()=>archive.set('two',true)).toThrow('索引损坏');expect(fs.readFileSync(file,'utf8')).toBe('{"unexpected":true}');
});
it('archives the selected chat, preserves its draft, and reveals the project when restored',async()=>{
 vi.stubGlobal('window',{localPi:{setSessionArchived:vi.fn().mockImplementation((_key,archived)=>Promise.resolve(archived?['chat']:[]))}});
 usePiStore.setState({selectedKey:'chat',runs:[],sessions:[{key:'chat',cwd:'/project',name:'Task'} as any],draftText:'unsent',contextItems:[],archivedKeys:[],expandedProjects:[],error:undefined});
 expect(await usePiStore.getState().setSessionArchived('chat',true)).toBe(true);
 expect(usePiStore.getState()).toMatchObject({selectedKey:null,archivedKeys:['chat'],draftText:'unsent',draftCwd:'/project'});
 await usePiStore.getState().setSessionArchived('chat',false);
 expect(usePiStore.getState().archivedKeys).toEqual([]);expect(usePiStore.getState().expandedProjects).toContain('/project');
});
it('keeps the chat visible when saving its archive state fails',async()=>{
 vi.stubGlobal('window',{localPi:{setSessionArchived:vi.fn().mockRejectedValue(new Error('disk full'))}});
 usePiStore.setState({selectedKey:'chat',archivedKeys:[]});
 expect(await usePiStore.getState().setSessionArchived('chat',true)).toBe(false);
 expect(usePiStore.getState()).toMatchObject({selectedKey:'chat',archivedKeys:[],error:'disk full'});
});
it('archives all project keys in one persisted update and preserves previous archives',()=>{
 const{archive,file}=setup();archive.set('previous',true);archive.setMany(['one','two','one'],true);
 expect(new SessionArchive(file).list()).toEqual(['previous','one','two']);
});
