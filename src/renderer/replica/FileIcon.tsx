/** 按扩展名渲染的文件类型小图标，对照 ZCode/编辑器惯例：TS 系蓝色、JS 系黄色、
 *  .tsx/.jsx 用 React 原子图、其余用彩色字母徽标。纯展示，无外部依赖。 */
export function FileIcon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  const name = typeof path === 'string' ? path.split('/').pop() || path : '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const badge = (label: string, bg: string, color = '#fff') => (
    <span
      className={`pi-fileicon pi-fileicon--badge${className ? ' ' + className : ''}`}
      style={{ width: size, height: size, background: bg, color, fontSize: Math.max(7, Math.floor(size * 0.42)) }}
      aria-hidden="true"
    >
      {label}
    </span>
  );
  // React 原子图（.tsx/.jsx），蓝色（TS）/青绿（JS）。
  if (ext === 'tsx' || ext === 'jsx') {
    const stroke = ext === 'tsx' ? '#3178c6' : '#61dafb';
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.3" className={`pi-fileicon${className ? ' ' + className : ''}`} aria-hidden="true">
        <ellipse cx="12" cy="12" rx="11" ry="4" />
        <ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(120 12 12)" />
        <circle cx="12" cy="12" r="1.6" fill={stroke} stroke="none" />
      </svg>
    );
  }
  switch (ext) {
    case 'ts': return badge('TS', '#3178c6');
    case 'js': case 'mjs': case 'cjs': return badge('JS', '#f7df1e', '#3a3a3a');
    case 'json': return badge('{}', '#cbcb41', '#1a1a1a');
    case 'md': case 'markdown': return badge('MD', '#519aba');
    case 'css': case 'scss': case 'sass': return badge('#', '#264de4');
    case 'html': case 'htm': return badge('<>', '#e34c26');
    case 'py': return badge('PY', '#3776ab');
    case 'sh': case 'bash': case 'zsh': return badge('$', '#89e051', '#1a1a1a');
    case 'yml': case 'yaml': return badge('Y', '#cb171e');
    case 'toml': return badge('T', '#9c4221');
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return badge('IMG', '#a074c4');
    case 'lock': return badge('🔒', '#8a8a8a', '#1a1a1a');
    case '': return badge('·', '#8a8a8a'); // 无扩展名
    default: return badge(ext.slice(0, 3).toUpperCase(), '#6b7280');
  }
}
