export interface DesktopProject { path: string; name: string; pinned?: boolean; section?: string }
export interface ProjectUpdate extends DesktopProject { remove?: boolean }
export interface WorktreeInput { projectPath: string; parentDirectory: string; folder: string; branch: string }
