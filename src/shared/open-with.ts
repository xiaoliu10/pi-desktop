/**
 * "Open current project with…" external apps. The main process detects an
 * allowlisted set (Finder / editors / Terminal); the renderer can only pick
 * an id — never a command, executable path or arbitrary arguments.
 */
export interface ExternalApp {
  /** Stable allowlist id: 'finder' | 'terminal' | 'intellij-idea' | 'webstorm' | 'pycharm' | 'vscode' | 'file-manager'. */
  id: string;
  /** Display name (proper noun; the renderer localizes the generic file-manager fallback). */
  name: string;
  /** .app bundle path on macOS; empty for the OS file-manager fallback. */
  path: string;
  kind: 'finder' | 'editor' | 'terminal';
  /** Real system icon as a data URL, best effort. */
  icon?: string;
}
