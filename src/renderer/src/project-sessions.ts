import { reactive } from 'vue';
import type { Project, ProjectWorkspaceState, WallViewState } from '../../shared/types';

export interface ProjectSession {
  id: string;
  name: string;
  workspace: ProjectWorkspaceState | null;
  wallViews: Record<string, WallViewState>;
  openWall: 'storyboard' | 'stills' | null;
  wallSelection: Record<string, string[]>;
  wallPresentation: Record<string, string>;
  detectionJobId: string | null;
  tasksPaused: boolean;
  taskCount: number;
  dirty: boolean;
}

export class ProjectSessionRegistry {
  readonly sessions = reactive<ProjectSession[]>([]);

  get(id: string): ProjectSession | undefined {
    return this.sessions.find((session) => session.id === id);
  }

  open(project: Pick<Project, 'id' | 'name'>): ProjectSession {
    const existing = this.get(project.id);
    if (existing) {
      existing.name = project.name;
      return existing;
    }
    this.sessions.push({
      id: project.id,
      name: project.name,
      workspace: null,
      wallViews: {},
      openWall: null,
      wallSelection: {},
      wallPresentation: {},
      detectionJobId: null,
      tasksPaused: false,
      taskCount: 0,
      dirty: false,
    });
    return this.sessions[this.sessions.length - 1]!;
  }

  close(id: string): void {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index >= 0) this.sessions.splice(index, 1);
  }

  clear(): void {
    this.sessions.splice(0);
  }
}
