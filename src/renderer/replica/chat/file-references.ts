export interface FileReference { path: string; line?: number }

const bareFile = /^(?:[\w-]+\.(?:md|mdx|txt|tsx?|jsx?|mjs|cjs|json|ya?ml|toml|py|go|rs|java|kt|vue|svelte|html|css|scss|sh|sql|xml|csv|log|png|jpe?g|gif|webp|pdf)|\.[\w.-]+|README|LICENSE|Dockerfile|Makefile)$/i;

/** Only file-shaped references; identifiers, URLs, commands and API routes stay text. */
export function parseFileReference(value: string, encoded = false): FileReference | null {
  let text = value.trim();
  if (encoded) { try { text = decodeURIComponent(text); } catch { return null; } }
  if (!text || /[\x00-\x1f\x7f]/.test(text)) return null;
  const location = /(?::([1-9]\d*)(?::[1-9]\d*)?|#L([1-9]\d*)(?:-L?[1-9]\d*)?)$/.exec(text);
  const line = location ? Number(location[1] ?? location[2]) : undefined;
  if (line !== undefined && !Number.isSafeInteger(line)) return null;
  if (location) text = text.slice(0, location.index);
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return null;
  if (/[?#<>`|*{};=]/.test(text) || /\s/.test(text) && !/[\\/]/.test(text)) return null;
  const basename = text.split(/[\\/]/).at(-1) ?? '';
  if (!basename || (!/[\\/]/.test(text) ? !bareFile.test(basename) : !bareFile.test(basename) && !/^[^\r\n]+\.[a-z\d]{1,12}$/i.test(basename))) return null;
  // A command prefix followed by a path is not a path, even inside inline code.
  if (/^(?:npm|pnpm|yarn|node|python3?|cat|cd|git|curl|bash|sh)\s/i.test(text)) return null;
  return { path: text, ...(line === undefined ? {} : { line }) };
}

type Node = { type: string; value?: string; url?: string; children?: Node[] };

/** Runs on parsed Markdown, never on fenced blocks or inside existing anchors. */
export function remarkFileReferences() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (node.type === 'code' || node.type === 'image' || node.type === 'html') return;
      if (node.type === 'inlineCode' && node.value) {
        const reference = parseFileReference(node.value);
        if (reference) Object.assign(node, { data: { hName: 'button', hProperties: { type: 'button', className: ['pi-md__file-link'], 'data-file-path': reference.path, 'data-file-line': reference.line }, hChildren: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: node.value }] }] } });
        return;
      }
      if (node.type === 'link') {
        const reference = parseFileReference(node.url ?? '', true);
        if (reference) Object.assign(node, { data: { hName: 'button', hProperties: { type: 'button', className: ['pi-md__file-link'], 'data-file-path': reference.path, 'data-file-line': reference.line } } });
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}
