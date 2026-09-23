import { expect, it } from 'vitest';
import { toolFilePreview } from '../src/renderer/pi/tool-file-preview';
import type { ToolPart } from '../src/renderer/replica/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCard } from '../src/renderer/replica/chat/ChatView';
const part: ToolPart = {kind:'tool',id:'edit',tool:'edit',status:'done',phase:'result',summary:'edit',argumentsText:JSON.stringify({path:'src/test.ts',oldText:'const x = 1;',newText:'const x = 2;\nconsole.log(x);'})};
it('previews the exact historical replacement with red and green lines',()=>{
 const result=toolFilePreview(part)!;
 expect(result.path).toBe('src/test.ts');
 expect(result.diff).toMatchObject({additions:2,deletions:1,created:false});
 expect(result.diff?.lines).toEqual([{type:'-',text:'const x = 1;'},{type:'+',text:'const x = 2;'},{type:'+',text:'console.log(x);'}]);
});
it('shows write content without inventing a previous version',()=>{
 const result=toolFilePreview({...part,tool:'write',argumentsText:JSON.stringify({path:'/project/file.txt',content:'saved'})})!;
 expect(result.content).toBe('saved');expect(result.diff).toBeUndefined();expect(result.note).toContain('没有写入前');
});
it('does not offer failed, unfinished or invalid edits as applied changes',()=>{
 for (const pending of [{...part,status:'error' as const},{...part,phase:'call' as const}]) {
  expect(toolFilePreview(pending)).toMatchObject({path:'src/test.ts',current:true});
  expect(toolFilePreview(pending)?.diff).toBeUndefined();
 }
 expect(toolFilePreview({...part,argumentsText:'null'})).toBeNull();
 expect(toolFilePreview({...part,argumentsText:'{'})).toBeNull();
});
it('renders a file button for successful modifications',()=>{
 const markup=renderToStaticMarkup(createElement(ToolCard,{part,labels:{you:'你'} as any,onOpenToolFile:()=>{}}));
 expect(markup).toContain('在右侧查看本次文件修改');expect(markup).toContain('>test.ts</button>');
});
it('opens successful read filenames through the current-file preview path',()=>{
 const read={...part,tool:'read',argumentsText:JSON.stringify({path:'/project/adapter.ts',offset:747,limit:50})};
 expect(toolFilePreview(read)).toMatchObject({path:'/project/adapter.ts',current:true});
 const markup=renderToStaticMarkup(createElement(ToolCard,{part:read,labels:{you:'你'} as any,onOpenToolFile:()=>{}}));
 expect(markup).toContain('在右侧查看文件及变更');expect(markup).toContain('>adapter.ts</button>');
});
it('can open read targets before a result exists and preserves the requested line',()=>{
 expect(toolFilePreview({...part,tool:'read',status:'running',phase:'call',argumentsText:JSON.stringify({filePath:'src/main.ts',offset:747})})).toMatchObject({path:'src/main.ts',current:true,line:747});
});

it('makes running edit and write filenames clickable without claiming unapplied content',()=>{
 for(const tool of ['edit','write']) {
  const pending={...part,tool,status:'running' as const,phase:'progress' as const};
  expect(toolFilePreview(pending)).toMatchObject({current:true,path:'src/test.ts'});
  expect(toolFilePreview(pending)?.content).toBeUndefined();
  const markup=renderToStaticMarkup(createElement(ToolCard,{part:pending,labels:{you:'你'} as any,onOpenToolFile:()=>{}}));
  expect(markup).toContain('在右侧查看文件及变更');expect(markup).toContain('>test.ts</button>');
 }
});
