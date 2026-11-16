import type { ProjectTask } from '../../shared/types';
import type { DetectService } from '../detect/detect-service';
import type { MediaService } from '../media/media-service';

export class TaskScheduler {
  constructor(
    private readonly getDetect: () => DetectService | null,
    private readonly getMedia: () => MediaService | null,
  ) {}

  list(projectId: string): ProjectTask[] {
    const result: ProjectTask[] = this.getDetect()?.listProjectTasks(projectId) ?? [];
    for (const item of this.getMedia()?.queueList() ?? []) {
      if (!item.projectIds?.includes(projectId) || (item.state !== 'waiting' && item.state !== 'running')) continue;
      result.push({ jobId: item.jobId, kind: 'transcode', state: item.state === 'waiting' ? 'queued' : 'running' });
    }
    return result;
  }

  setPaused(projectId: string, paused: boolean): void {
    this.getDetect()?.setProjectPaused(projectId, paused);
    this.getMedia()?.setProjectPaused(projectId, paused);
  }

  async release(projectId: string): Promise<void> {
    await Promise.all([
      this.getDetect()?.releaseProject(projectId),
      this.getMedia()?.releaseProject(projectId),
    ]);
  }
}
