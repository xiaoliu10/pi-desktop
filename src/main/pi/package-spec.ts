/**
 * pi 包 spec（npm:name 或 npm:name@range）→ 纯包名。
 * npm:@scope/name@^1.2.3 → @scope/name；npm:name → name；npm:@scope/name → @scope/name。
 * 供 builtin-packages / packages-repair / plan-package 做按名判定：
 * 「带版本范围」与「裸名」是同一个包，精确字符串比对会造成重复注册（v0.1.47 用户实测）。
 */
export function packageNameOf(spec: string): string {
  const raw = spec.startsWith('npm:') ? spec.slice(4) : spec;
  const at = raw.lastIndexOf('@');
  return at > 0 ? raw.slice(0, at) : raw;
}
