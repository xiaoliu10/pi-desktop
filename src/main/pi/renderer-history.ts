import type { PiEntry, PiHistory } from '../../shared/pi';

/** Desktop-only transport projection. Internal SessionIndex history remains lossless.
 * Entries/content arrays are immutable: SessionIndex replaces them on append/reparse.
 * Paged responses may have fresh arrays; entry-level memoization still reuses projections. */
export class RendererHistory {
  private entries = new WeakMap<PiEntry, PiEntry>();
  private arrays = new WeakMap<PiEntry[], PiEntry[]>();
  private histories = new WeakMap<PiHistory, PiHistory>();

  project(history: PiHistory): PiHistory {
    const hit = this.histories.get(history);
    if (hit) return hit;
    const branch = this.projectEntries(history.branch);
    const entries = history.entries === history.branch ? branch : this.projectEntries(history.entries);
    const result = branch === history.branch && entries === history.entries
      ? history : { ...history, branch, entries };
    // Also memoize no-op projections, so unchanged histories skip repeat traversal.
    this.histories.set(history, result);
    return result;
  }

  private projectEntries(entries: PiEntry[]): PiEntry[] {
    const hit = this.arrays.get(entries);
    if (hit) return hit;
    let changed = false;
    const result = entries.map(entry => {
      let projected = this.entries.get(entry);
      if (!projected) {
        projected = entry;
        const message = entry.message;
        // historyToMessages consumes toolResult text/details, not image content.
        // Do not touch user attachments, other roles, or nested tool details.
        if (message?.role === 'toolResult' && Array.isArray(message.content)) {
          let removed = false;
          const content = message.content.map((block: unknown) => {
            if (!block || typeof block !== 'object') return block;
            const image = block as Record<string, unknown>;
            if (image.type !== 'image' || typeof image.data !== 'string') return block;
            const { data, ...metadata } = image;
            removed = true;
            return { ...metadata, omittedBase64Chars: data.length };
          });
          if (removed) projected = { ...entry, message: { ...message, content } };
        }
        this.entries.set(entry, projected);
      }
      if (projected !== entry) changed = true;
      return projected;
    });
    const projected = changed ? result : entries;
    this.arrays.set(entries, projected);
    return projected;
  }
}
