/**
 * Provider brand logos for the model configuration page. Known providers get
 * their simple-icons mark; unknown ones fall back to a colored first-letter
 * avatar so every provider row has a recognizable glyph.
 */

import { memo } from 'react';

// Single-path marks from simple-icons (24×24 viewBox, fill=currentColor).
const PATHS: Record<string, string> = {
  openai: 'M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zM13.26 22.43a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5z',
  anthropic: 'M17.3 3.54h-3.67L20.33 20.46H24zM6.7 3.54 0 20.46h3.74l1.37-3.55h7.01l1.37 3.55h3.74L10.54 3.54zm-.37 10.22 2.29-5.95 2.29 5.95z',
  deepseek: 'M23.75 4.65c-.25-.12-.36.11-.51.23-.05.04-.09.09-.14.14-.37.4-.8.66-1.37.63-.83-.05-1.54.21-2.16.85a4.3 4.3 0 0 0-1.25-1.55c-.35-.16-.71-.31-.95-.65a3.3 3.3 0 0 1-.31-.77c-.05-.16-.11-.32-.29-.35-.2-.03-.28.14-.36.28a4.6 4.6 0 0 0-.42 1.84 4.5 4.5 0 0 0 1.84 3.4c.14.09.17.18.13.32-.08.28-.18.55-.27.83-.05.18-.13.22-.32.14a5.5 5.5 0 0 1-1.74-1.18c-.86-.83-1.63-1.74-2.6-2.46a12 12 0 0 0-.69-.47c-.98-.96.13-1.74.39-1.83.27-.1.09-.44-.78-.43-.87 0-1.67.3-2.69.69-.15.05-.31.09-.46.13a9.6 9.6 0 0 0-2.89-.1C1.88 4.3.38 5.18-.72 6.7c-1.1 1.52-1.42 3.6-1.04 5.76a10.7 10.7 0 0 0 3.36 5.66c1.86 1.53 4 2.28 6.44 2.14 1.48-.09 3.13-.28 4.99-1.86.47.23.96.33 1.78.4.63.06 1.24-.03 1.7-.13.74-.15.69-.84.42-.96-2.16-1-1.68-.6-2.11-.93 1.1-1.3 2.77-3.6 3.28-6.73.05-.35.12-.84.11-1.12 0-.17.03-.24.23-.26a4.2 4.2 0 0 0 1.54-.48c1.4-.76 1.96-2.02 2.1-3.52.02-.23 0-.47-.25-.59',
  qwen: 'M23.92 14.55 20.82 9.17l1.47-2.54a.56.56 0 0 0 0-.57l-1.63-2.83a.57.57 0 0 0-.49-.28h-6.21L12.49.4a.57.57 0 0 0-.49-.28H8.73a.56.56 0 0 0-.49.28L5.14 5.78h-2.94a.56.56 0 0 0-.49.28L.08 8.89a.56.56 0 0 0 0 .57L3.18 14.83l-1.47 2.55a.56.56 0 0 0 0 .56l1.63 2.83a.57.57 0 0 0 .49.28h6.21l1.47 2.55a.57.57 0 0 0 .49.28h3.26a.57.57 0 0 0 .49-.28l3.1-5.38h2.94a.57.57 0 0 0 .49-.28l1.63-2.83a.55.55 0 0 0 0-.57M8.73.69l1.63 2.83-1.63 2.83H21.8L20.16 9.17H7.43L5.63 6.06z',
  google: 'M12.48 10.92v3.28h7.84a6.7 6.7 0 0 1-1.79 4.13c-1.15 1.15-2.93 2.4-6.05 2.4a8.6 8.6 0 1 1 0-17.44c2.6 0 4.5 1.03 5.9 2.35l2.31-2.31A11.7 11.7 0 0 0 12.48 0 12 12 0 1 0 24 12c0-.76-.05-1.47-.17-2.05H12.48z',
  vllm: 'm23.6 0-8.72 4.59L9.83 24h7.41zM9.83 24V5.14H.4z',
  minimax: 'M11.43 3.92a.86.86 0 1 0-1.72 0v14.24a2 2 0 0 1',
};

// Brand colors so each logo reads at a glance even before the path resolves.
const COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#cc785c',
  deepseek: '#4d6bfe',
  qwen: '#6f42c1',
  google: '#4285f4',
  vllm: '#76b900',
  minimax: '#ff4d4f',
};

// Fallback avatar palette (deterministic by id hash).
const AVATAR_COLORS = ['#6e7681', '#8957e5', '#1f6feb', '#2da44e', '#bf3989', '#d4733a', '#0969da', '#a371f0'];

function matchBrand(id: string, name: string): string | null {
  const hay = `${id} ${name}`.toLowerCase();
  if (/openai|codex/.test(hay)) return 'openai';
  if (/claude|anthropic|ccr/.test(hay)) return 'anthropic';
  if (/deepseek/.test(hay)) return 'deepseek';
  if (/qwen|tongyi|alibaba/.test(hay)) return 'qwen';
  if (/google|gemini/.test(hay)) return 'google';
  if (/vllm|gpu|ollama/.test(hay)) return 'vllm';
  if (/minimax/.test(hay)) return 'minimax';
  return null;
}

export const ProviderLogo = memo(function ProviderLogo({ id, name, baseUrl, size = 20 }: { id: string; name?: string; baseUrl?: string; size?: number }) {
  const brand = matchBrand(id, name ?? '');
  if (brand && PATHS[brand]) {
    return (
      <span className="pi-provider-logo" style={{ width: size, height: size, color: COLORS[brand] }} aria-hidden="true">
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor"><path d={PATHS[brand]} /></svg>
      </span>
    );
  }
  // Fallback: first letter of the provider name/id, on a deterministic tint.
  const letter = (name || id).replace(/^@?[^a-zA-Z0-9]+/, '').charAt(0).toUpperCase() || '?';
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const bg = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  return (
    <span className="pi-provider-logo pi-provider-logo--fallback" style={{ width: size, height: size, background: bg }} aria-hidden="true">
      {letter}
    </span>
  );
});
