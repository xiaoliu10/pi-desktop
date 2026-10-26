import { describe, expect, it } from 'vitest';
import { fileUrlToPath, markdownUrlTransform } from '../src/renderer/replica/chat/file-url';

describe('markdownUrlTransform', () => {
  it('preserves file:// hrefs that react-markdown would strip', () => {
    expect(markdownUrlTransform('file:///tmp/a.png')).toBe('file:///tmp/a.png');
    expect(markdownUrlTransform('file:/tmp/a.png')).toBe(''); // 非标准形态与 fileUrlToPath 同谓词，不放行
  });
  it('keeps default behavior for web, relative and dangerous URLs', () => {
    expect(markdownUrlTransform('https://example.com/x')).toBe('https://example.com/x');
    expect(markdownUrlTransform('./docs/a.md')).toBe('./docs/a.md');
    expect(markdownUrlTransform('javascript:alert(1)')).toBe('');
  });
});

describe('fileUrlToPath', () => {
  it('decodes file:// absolute URLs including CJK names', () => {
    expect(fileUrlToPath('file:///Users/jason/ai-workspace/design/浙江省财政厅生产环境部署架构图/浙江省财政厅生产环境部署架构图-简化版.png'))
      .toBe('/Users/jason/ai-workspace/design/浙江省财政厅生产环境部署架构图/浙江省财政厅生产环境部署架构图-简化版.png');
  });
  it('decodes percent-encoded characters', () => {
    expect(fileUrlToPath('file:///Users/a%20b/report%20final.pdf')).toBe('/Users/a b/report final.pdf');
  });
  it('normalizes Windows drive-letter URLs', () => {
    expect(fileUrlToPath('file:///C:/Users/jason/diagram.html')).toBe('C:/Users/jason/diagram.html');
  });
  it('keeps file://localhost as a local path', () => {
    expect(fileUrlToPath('file://localhost/tmp/x.png')).toBe('/tmp/x.png');
  });
  it('rejects non-file schemes, remote hosts and non-URL paths', () => {
    expect(fileUrlToPath('https://example.com/x.png')).toBeNull();
    expect(fileUrlToPath('file://nas/share/x.png')).toBeNull();
    expect(fileUrlToPath('/tmp/x.png')).toBeNull();
    expect(fileUrlToPath('javascript:alert(1)')).toBeNull();
    expect(fileUrlToPath('')).toBeNull();
    expect(fileUrlToPath(undefined)).toBeNull();
  });
  it('rejects malformed escapes and non-absolute results', () => {
    expect(fileUrlToPath('file:///tmp/%E0%A4%A.png')).toBeNull();
    expect(fileUrlToPath('file://')).toBeNull();
    expect(fileUrlToPath('file:///tmp/%00.png')).toBeNull();
  });
  it('canonicalizes encoded dot segments and rejects non-canonical single-slash URLs', () => {
    // WHATWG URL 在解析时就把 %2e%2e 折叠掉：不会残留 '..' 段，结果是规范化绝对路径。
    expect(fileUrlToPath('file:///tmp/%2e%2e/%2e%2e/etc/secret.pdf')).toBe('/etc/secret.pdf');
    expect(fileUrlToPath('file:/tmp/x.png')).toBeNull();
  });
});
