import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FileCodeViewer} from '../src/renderer/replica/workbench/FileCodeViewer';
it('renders syntax, line numbers and escapes file text as non-executable content',()=>{
 const html=renderToStaticMarkup(createElement(FileCodeViewer,{path:'a.ts',content:'const x = 1;\n// <script>alert(1)</script>',line:2}));
 expect(html).toContain('hljs-keyword');expect(html).toContain('is-focused">2');expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
});
