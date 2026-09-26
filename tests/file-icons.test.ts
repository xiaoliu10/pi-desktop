import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileIcon, resolveFileIconName, resolveFileIconUrl } from '../src/renderer/replica/FileIcon';
import { FILE_ICON_URLS } from '../src/renderer/replica/file-icons.generated';

// ZCode 同款文件图标：Material Icon Theme 素材 + resolveIconName 移植。
describe('文件类型图标（ZCode material-icons 移植）', () => {
  it('css 解析到 css 素材，紫色 #7e57c2（用户报告的样式）', () => {
    expect(resolveFileIconName('src/renderer/styles.css')).toBe('css');
    const url = resolveFileIconUrl('src/renderer/styles.css');
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    // #7e57c2 URL 编码后为 %237e57c2
    expect(decodeURIComponent(url)).toContain('#7e57c2');
  });

  it('逐段回退命中多段配置文件名，扩展名别名对齐素材名', () => {
    expect(resolveFileIconName('vitest.config.ts')).toBe('vitest');
    expect(resolveFileIconName('tsconfig.base.json')).toBe('tsconfig');
    expect(resolveFileIconName('.env.local')).toBe('settings');
    expect(resolveFileIconName('.gitignore')).toBe('git');
    expect(resolveFileIconName('Dockerfile')).toBe('docker');
    expect(resolveFileIconName('app.tsx')).toBe('react_ts');
    expect(resolveFileIconName('index.js')).toBe('javascript');
    expect(resolveFileIconName('a.scss')).toBe('sass');
    expect(resolveFileIconName('README.md')).toBe('readme');
  });

  it('未知扩展名原样透传（ZCode 原语义），URL 层兕底 document 永不落空', () => {
    expect(resolveFileIconName('archive.weird')).toBe('weird');
    expect(resolveFileIconName('LICENSE')).toBe('document');
    expect(FILE_ICON_URLS.document).toBeTruthy();
    // 未打包的素材名（未知扩展名直落）在 URL 层兕底，避免 404
    expect(resolveFileIconUrl('archive.weird')).toBe(FILE_ICON_URLS.document);
  });

  it('渲染为内联 svg img（非字母徽标）', () => {
    const html = renderToStaticMarkup(createElement(FileIcon, { path: 'styles.css', size: 17 }));
    expect(html).toContain('<img');
    expect(html).toContain('data:image/svg+xml');
    expect(html).toContain('width="17"');
    expect(html).not.toContain('pi-fileicon--badge');
  });

  it('素材集完整：映射表引用的每个名字都有 data URL', () => {
    const names = ['audio','babel','console','css','database','docker','document','editorconfig','eslint','folder','gemfile','git','go','html','image','java','javascript','jest','json','less','lock','makefile','markdown','nodejs_alt','npm','pdf','php','powerpoint','prettier','python','react','react_ts','readme','rust','sass','settings','snapcraft','storybook','svg','table','toml','tsconfig','typescript','video','vitest','word','yaml','yarn'];
    for (const n of names) expect(FILE_ICON_URLS[n], n).toBeTruthy();
  });
});
