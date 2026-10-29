import type { DataLayer } from '../../data/db';
import { formatTimeMs } from '../../shared/time';
import type {
  AiContinuityCandidate,
  AiProjectSnapshot,
  AiSnapshotShot,
  Note,
  Shot,
  Tag,
} from '../../shared/types';

const TAG_CATEGORIES = ['景别', '机位', '运镜', '光线', '声音', '剪辑'];

export function buildProjectSnapshot(data: DataLayer, projectId: string): AiProjectSnapshot {
  const project = data.projects.get(projectId);
  const shots = data.shots.list(projectId);
  const tags = data.tags.list();
  const notes = data.notes.list({ projectId });
  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  const notesByShot = new Map<string, Note[]>();
  for (const note of notes) {
    const items = notesByShot.get(note.shotId) ?? [];
    items.push(note);
    notesByShot.set(note.shotId, items);
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      filename: project.media.filename,
      container: project.media.container,
      durationMs: project.media.durationMs,
      width: project.media.width,
      height: project.media.height,
      fps: project.media.fps,
      videoCodec: project.media.videoCodec,
      audioCodec: project.media.audioCodec,
      shotCount: shots.length,
    },
    shots: shots.map((shot) => snapshotShot(shot, tagById, notesByShot.get(shot.id) ?? [])),
    generatedAt: new Date().toISOString(),
  };
}

export function snapshotToText(snapshot: AiProjectSnapshot): string {
  const lines = [
    `# ${snapshot.project.name}`,
    '',
    `- 镜头数：${snapshot.project.shotCount}`,
    `- 素材：${snapshot.project.filename ?? '未记录'}`,
    `- 规格：${snapshot.project.width ?? '?'}×${snapshot.project.height ?? '?'} · ${snapshot.project.fps ?? '?'} fps`,
    `- 时长：${formatTimeMs(snapshot.project.durationMs)}`,
    '',
    '## 镜头明细',
  ];

  if (snapshot.shots.length === 0) {
    lines.push('', '当前项目暂无镜头。');
    return lines.join('\n');
  }

  for (const shot of snapshot.shots) {
    lines.push(
      '',
      `### 镜头 ${String(shot.index).padStart(2, '0')}`,
      `- 时间：${formatTimeMs(shot.startMs)} – ${formatTimeMs(shot.endMs)}`,
      `- 景别：${shot.shotSize ?? '未标注'}`,
      `- 摄法/运镜：${shot.cameraMethod ?? '未标注'}`,
    );
    const tags = Object.entries(shot.tags)
      .filter(([, names]) => names.length > 0)
      .map(([category, names]) => `${category}：${names.join('、')}`);
    lines.push(`- 标签：${tags.length > 0 ? tags.join('；') : '无'}`);
    lines.push(`- 笔记：${shot.note?.trim() || '无'}`);
  }
  return lines.join('\n');
}

export function snapshotToJson(snapshot: AiProjectSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function buildContinuityCandidates(snapshot: AiProjectSnapshot): AiContinuityCandidate[] {
  const candidates: AiContinuityCandidate[] = [];
  for (let index = 1; index < snapshot.shots.length; index += 1) {
    const previous = snapshot.shots[index - 1];
    const current = snapshot.shots[index];
    const reasons: string[] = [];

    if (previous.shotSize !== current.shotSize) {
      reasons.push(
        `景别从“${previous.shotSize ?? '未标注'}”变为“${current.shotSize ?? '未标注'}”`,
      );
    }
    const cameraBefore = (previous.tags['机位'] ?? []).join('、') || previous.cameraMethod || '未标注';
    const cameraAfter = (current.tags['机位'] ?? []).join('、') || current.cameraMethod || '未标注';
    if (cameraBefore !== cameraAfter) reasons.push(`机位可能变化：${cameraBefore} → ${cameraAfter}`);

    const motionBefore = (previous.tags['运镜'] ?? []).join('、') || '未标注';
    const motionAfter = (current.tags['运镜'] ?? []).join('、') || '未标注';
    if (motionBefore !== motionAfter) reasons.push(`运镜可能变化：${motionBefore} → ${motionAfter}`);

    if (reasons.length > 0) {
      candidates.push({
        fromShotId: previous.id,
        fromShotIndex: previous.index,
        toShotId: current.id,
        toShotIndex: current.index,
        reasons,
      });
    }
  }
  return candidates;
}

export function buildProjectSummary(snapshot: AiProjectSnapshot): Record<string, unknown> {
  const categories: Record<string, Record<string, number>> = {};
  for (const category of TAG_CATEGORIES) categories[category] = {};
  let annotated = 0;
  let totalDurationMs = 0;
  for (const shot of snapshot.shots) {
    totalDurationMs += shot.durationMs;
    for (const [category, names] of Object.entries(shot.tags)) {
      for (const name of names) {
        categories[category] ??= {};
        categories[category][name] = (categories[category][name] ?? 0) + 1;
      }
    }
    if (Object.values(shot.tags).some((names) => names.length > 0) || Boolean(shot.note?.trim())) {
      annotated += 1;
    }
  }
  return {
    projectId: snapshot.project.id,
    projectName: snapshot.project.name,
    shotCount: snapshot.project.shotCount,
    annotatedShotCount: annotated,
    progressPercent:
      snapshot.project.shotCount > 0 ? Math.round((annotated / snapshot.project.shotCount) * 1000) / 10 : 0,
    totalShotDurationMs: totalDurationMs,
    averageShotDurationMs:
      snapshot.project.shotCount > 0 ? Math.round(totalDurationMs / snapshot.project.shotCount) : 0,
    tags: categories,
  };
}

function snapshotShot(
  shot: Shot,
  tagById: Map<string, Tag>,
  notes: Note[],
): AiSnapshotShot {
  const tags: Record<string, string[]> = Object.fromEntries(TAG_CATEGORIES.map((category) => [category, []]));
  for (const tag of shot.tagIds.map((id) => tagById.get(id)).filter((item): item is Tag => Boolean(item)).sort((a, b) => a.sortOrder - b.sortOrder)) {
    tags[tag.category] ??= [];
    tags[tag.category].push(tag.name);
  }
  const note = notes
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n');
  return {
    id: shot.id,
    index: shot.index,
    startMs: shot.startMs,
    endMs: shot.endMs,
    durationMs: shot.durationMs,
    shotSize: shot.shotSize,
    cameraMethod: shot.cameraMethod,
    dialogue: shot.dialogue,
    remark: shot.remark,
    tagIds: shot.tagIds,
    tags,
    note: note || null,
    noteLength: note.length,
    origin: shot.origin,
    locked: shot.locked,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
}
