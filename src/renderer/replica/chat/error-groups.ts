import type { ErrorPart, MessagePart } from '../contracts';

function key(part: ErrorPart): string {
  return part.groupKey ?? JSON.stringify([part.context ?? '', part.message.trim()]);
}

function occurrences(part: ErrorPart): NonNullable<ErrorPart['occurrences']> {
  return part.occurrences ?? [{ id: part.id, details: part.details || part.message, missingCause: part.missingCause }];
}

/** Only adjacent failures in one assistant turn merge; intervening output remains a boundary. */
export function coalesceErrors(parts: MessagePart[]): MessagePart[] {
  const result: MessagePart[] = [];
  for (const part of parts) {
    if (part.kind === 'text' && !part.text.trim()) continue;
    const previous = result.at(-1);
    if (part.kind !== 'error' || previous?.kind !== 'error' || key(part) !== key(previous)) {
      result.push(part);
      continue;
    }
    const attempts = new Map(occurrences(previous).map(item => [item.id, item]));
    for (const item of occurrences(part)) attempts.set(item.id, item);
    result[result.length - 1] = { ...previous, occurrences: [...attempts.values()] };
  }
  return result;
}

export function retryErrorIds(parts: MessagePart[], retryError?: string): Set<string> {
  const ids = new Set<string>();
  // 只藏「本次重试对应」的末尾同类错误组；异类错误（如先网络断、后 429）保留独立卡片。
  // pi 重试的永远是最近一次失败，末尾不同错误即断开。
  const needle = retryError?.split('\n')[0]?.trim();
  if (!needle) return ids;
  for (let i = parts.length - 1; i >= 0 && parts[i].kind === 'error'; i--) {
    const part = parts[i] as ErrorPart;
    if (part.message.split('\n')[0].trim() !== needle) break;
    ids.add(part.id);
  }
  return ids;
}
