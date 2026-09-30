import { useEffect, useRef, useState } from 'react';
import type { ErrorPart } from '../contracts';
import { Icon } from '../Icons';
import { redactDiagnosticText } from '../../../../extensions/desktop-policy/diagnostic-text.mjs';

export function ChatError({ part, zh }: { part: ErrorPart; zh: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  // Sanitize at the display/copy boundary as well (demo and other adapters can create ErrorParts).
  const message = redactDiagnosticText(part.message);
  const context = redactDiagnosticText(part.context);
  const firstLine = message.split('\n').find(line => line.trim()) || (zh ? '请求失败' : 'Request failed');
  const summary = firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
  const missingCause = part.missingCause ?? (!part.details && /^(?:fetch failed|connection error\.?)$/i.test(message.trim()));
  const hint = missingCause
    ? (zh ? '运行时未记录底层原因，无法仅凭此消息判断是连接、超时还是服务端问题。' : 'The runtime did not record the underlying cause; this message alone cannot identify a connection, timeout or server issue.')
    : (zh ? '可展开查看原始错误及运行时诊断。' : 'Expand for the error message and runtime diagnostics.');
  const count = part.occurrences?.length ?? 1;
  const details = part.occurrences
    ? part.occurrences.map((item, index) => [
      zh ? `第 ${index + 1}/${count} 次错误` : `Error ${index + 1}/${count}`,
      redactDiagnosticText(item.details),
      ...(item.missingCause ? ['', zh ? '运行时未记录底层原因。' : 'The runtime did not record the underlying cause.'] : []),
    ].join('\n')).join('\n\n---\n\n')
    : [redactDiagnosticText(part.details) || message, ...(missingCause ? ['', hint] : [])].join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true); setCopyFailed(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch { setCopyFailed(true); }
  };
  return <div className="pi-error pi-error-card">
    <div className="pi-error-card__heading"><Icon name="info" size={16} /><strong>{summary}</strong>{count > 1 && <span className="pi-error-card__count">{zh ? `相同错误 ${count} 次` : `Same error ×${count}`}</span>}</div>
    <details className="pi-error-card__details">
      <summary>{zh ? '查看错误详情' : 'Show error details'}</summary>
      {context && <div className="pi-error-card__context">{context}</div>}
      <p className="pi-error-card__hint">{hint}</p>
      <div className="pi-error-card__tools">
        <span>{zh ? '诊断中的常见敏感字段已隐藏' : 'Common sensitive fields are redacted'}</span>
        <button type="button" onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制错误详情' : 'Copy error details')}</button>
      </div>
      {copyFailed && <p role="status">{zh ? '复制失败，请手动选择下方文本复制。' : 'Could not copy. Select and copy the text below.'}</p>}
      <pre tabIndex={0}>{details}</pre>
    </details>
  </div>;
}
