import type { Shot, Term } from '../../../shared/types';

export interface WorkspaceShot extends Shot {
  /** 内置示例镜头使用随包静帧；真实项目可后续替换为 still 记录 */
  thumbnail: string;
  title: string;
  scene: string;
  noteId?: string;
  /** 独立分镜本文本节点才有：画面文字（双击卡片进入内联编辑） */
  textContent?: string;
}

export interface TimelineMarker {
  id: string;
  shotId: string;
  timeMs: number;
  type: 'still' | 'note';
  label: string;
}

export interface BoundaryChange {
  index: number;
  timeMs: number;
}

export interface DetailTerm extends Term {
  selected?: boolean;
}
