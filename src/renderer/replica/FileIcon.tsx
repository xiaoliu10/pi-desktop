// ZCode 同款文件类型小图标（Material Icon Theme 素材，MIT）。
// 解析逻辑移植自 ZCode fileDisplayHelpers.resolveIconName：
// 1) 逐段回退的文件名别名（vitest.config.ts / tsconfig.base.json / .env.local 这类多段名
//    不能提前退回扩展名图标，否则配置文件语义丢失）；
// 2) 扩展名别名（tsx 实际素材叫 react_ts）；
// 3) 未知扩展名回退 document，全部走内联 data URL（避开 Electron 相对路径 404）。
import { FILE_ICON_URLS } from './file-icons.generated';

export const DEFAULT_FILE_ICON_NAME = 'document';

const FILE_NAME_ICON_ALIASES: Record<string, string> = {
  '.editorconfig': 'editorconfig',
  '.env': 'settings',
  '.gitattributes': 'git',
  '.gitignore': 'git',
  '.npmrc': 'npm',
  '.nvmrc': 'nodejs_alt',
  '.prettierrc': 'prettier',
  '.yarnrc': 'yarn',
  'babel.config': 'babel',
  bun: 'lock',
  'bun.lock': 'lock',
  cargo: 'rust',
  'cargo.lock': 'lock',
  dockerfile: 'docker',
  eslint: 'eslint',
  'eslint.config': 'eslint',
  gemfile: 'gemfile',
  jest: 'jest',
  'jest.config': 'jest',
  makefile: 'makefile',
  'package-lock': 'lock',
  'pnpm-lock': 'lock',
  readme: 'readme',
  tsconfig: 'tsconfig',
  vitest: 'vitest',
  'vitest.config': 'vitest',
  yarn: 'yarn',
};

const EXTENSION_ICON_ALIASES: Record<string, string> = {
  backup: 'document',
  bash: 'console',
  cjs: 'javascript',
  css: 'css',
  cts: 'typescript',
  doc: 'word',
  docx: 'word',
  go: 'go',
  html: 'html',
  htm: 'html',
  java: 'java',
  jpeg: 'image',
  jpg: 'image',
  js: 'javascript',
  jsx: 'react',
  json: 'json',
  jsonl: 'json',
  less: 'less',
  mjs: 'javascript',
  md: 'markdown',
  markdown: 'markdown',
  m4a: 'audio',
  m4v: 'video',
  flac: 'audio',
  mov: 'video',
  mp3: 'audio',
  mp4: 'video',
  ogg: 'audio',
  opus: 'audio',
  mts: 'typescript',
  pdf: 'pdf',
  php: 'php',
  png: 'image',
  pptx: 'powerpoint',
  py: 'python',
  responses: 'json',
  rs: 'rust',
  sb: 'storybook',
  scss: 'sass',
  sass: 'sass',
  sql: 'database',
  sh: 'console',
  snap: 'snapcraft',
  svg: 'svg',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'react_ts',
  txt: 'document',
  wav: 'audio',
  weba: 'audio',
  webm: 'video',
  xlsx: 'table',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'console',
};

/** ZCode resolveIconName：先逐段回退命中文件名别名，再按扩展名别名解析。 */
export function resolveFileIconName(path: string): string {
  const normalizedPath = typeof path === 'string' ? path.replace(/\\/g, '/') : '';
  const lastSlash = normalizedPath.lastIndexOf('/');
  const leaf = lastSlash === -1 ? normalizedPath : normalizedPath.slice(lastSlash + 1);
  const normalizedLeaf = leaf.toLowerCase();
  const lastDot = leaf.lastIndexOf('.');
  const stem = lastDot === -1 ? normalizedLeaf : normalizedLeaf.slice(0, lastDot);

  const fileNameCandidates = new Set<string>([normalizedLeaf, stem]);
  let stemCandidate = stem;
  while (stemCandidate.includes('.')) {
    stemCandidate = stemCandidate.slice(0, stemCandidate.lastIndexOf('.'));
    if (stemCandidate) fileNameCandidates.add(stemCandidate);
  }
  for (const candidate of fileNameCandidates) {
    const aliased = FILE_NAME_ICON_ALIASES[candidate];
    if (aliased) return aliased;
  }
  if (lastDot === -1) return DEFAULT_FILE_ICON_NAME;
  const extension = leaf.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ICON_ALIASES[extension] ?? extension;
}

/** 解析到素材名；未打包的素材名（未知扩展名直落）回退 document，保证永不 404。 */
export function resolveFileIconUrl(path: string): string {
  const name = resolveFileIconName(path);
  return FILE_ICON_URLS[name] ?? FILE_ICON_URLS[DEFAULT_FILE_ICON_NAME];
}

export function FileIcon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  return (
    <img
      src={resolveFileIconUrl(path)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={`pi-fileicon pi-fileicon--svg${className ? ' ' + className : ''}`}
      draggable={false}
    />
  );
}
