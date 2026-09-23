export interface GitStatus {
  root: string; repository: boolean; branch: string; branches: string[];
  added: number; removed: number; changed: number; untracked: number;
  binary: number; ahead: number; behind: number; error?: string;
}
export interface PlanItem { step: string; status: 'pending' | 'in_progress' | 'completed' }
