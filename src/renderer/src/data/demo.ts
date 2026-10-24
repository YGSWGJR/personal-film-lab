import shot01 from '../assets/demo-stills/shot-01.jpg';
import shot02 from '../assets/demo-stills/shot-02.jpg';
import shot03 from '../assets/demo-stills/shot-03.jpg';
import shot04 from '../assets/demo-stills/shot-04.jpg';
import shot05 from '../assets/demo-stills/shot-05.jpg';
import shot06 from '../assets/demo-stills/shot-06.jpg';
import shot07 from '../assets/demo-stills/shot-07.jpg';
import shot08 from '../assets/demo-stills/shot-08.jpg';
import shot09 from '../assets/demo-stills/shot-09.jpg';
import shot10 from '../assets/demo-stills/shot-10.jpg';
import type { Tag } from '../../../shared/types';
import type { DetailTerm, TimelineMarker, WorkspaceShot } from '../types/workspace';

export const DEMO_THUMBNAILS = [
  shot01,
  shot02,
  shot03,
  shot04,
  shot05,
  shot06,
  shot07,
  shot08,
  shot09,
  shot10,
];

const DEMO_DEFINITIONS = [
  { start: 0, end: 9_200, size: '全景', title: '数据瀑布', scene: '序章 · 系统启动', camera: '横摇', image: shot01 },
  { start: 9_200, end: 21_000, size: '中景', title: '遗迹入口', scene: '序章 · 系统启动', camera: '跟拍', image: shot02 },
  { start: 21_000, end: 34_000, size: '中景', title: '虚拟舞台', scene: '场景 A · 发布会', camera: '固定', image: shot03 },
  { start: 34_000, end: 47_500, size: '特写', title: '阵列屏幕', scene: '场景 A · 发布会', camera: '缓推', image: shot04 },
  { start: 47_500, end: 59_000, size: '全景', title: '直播现场', scene: '场景 A · 发布会', camera: '环摇', image: shot05 },
  { start: 59_000, end: 73_500, size: '中景', title: '台上对峙', scene: '场景 A · 发布会', camera: '固定', image: shot06 },
  { start: 73_500, end: 88_000, size: '近景', title: '质疑响起', scene: '场景 A · 发布会', camera: '手持', image: shot07 },
  { start: 88_000, end: 103_000, size: '特写', title: '视线交换', scene: '场景 B · 后台', camera: '侧跟', image: shot08 },
  { start: 103_000, end: 119_000, size: '空镜', title: '暗处回廊', scene: '场景 B · 后台', camera: '横移', image: shot09 },
  { start: 119_000, end: 142_000, size: '特写', title: '握枪的手', scene: '场景 B · 后台', camera: '微推', image: shot10 },
] as const;

const DEMO_NOTES = [
  '高饱和金色与黑底形成强对比，用密集线条制造信息过载感。',
  '从系统界面切到现实空间，冷紫色光源先于人物出现。',
  '舞台使用对称构图，人物被压在画面下三分之一。',
  '屏幕占据主视觉，视线从弹幕引向主持人。',
  '广角交代三方坐席关系，背景弹幕持续流动。',
  '前景男主背影形成过肩关系，把两位主持隔离在舞台光里。',
  '人物居中近景，切点落在台词之前，强化反应。',
  '浅景深把二人从紫黑环境中剥离，视线方向形成隐性轴线。',
  '空镜停留 1.2 秒，利用机械结构制造压迫与未知感。',
  '手部特写不露脸，用局部信息完成悬念落点。',
];

const CREATED_AT = '2026-10-24T00:00:00.000Z';
export const DEFAULT_TAG_GROUPS = [
  { category: '景别', items: ['远景', '全景', '中景', '近景', '特写'] },
  { category: '机位', items: ['正面', '侧面', '过肩', '俯拍', '仰拍'] },
  { category: '运镜', items: ['固定', '推', '拉', '摇', '跟', '手持'] },
  { category: '光线', items: ['自然光', '冷光', '逆光', '硬光'] },
  { category: '声音', items: ['对白', '环境', '音乐', '无声'] },
  { category: '剪辑', items: ['硬切', '叠化', '闪白'] },
] as const;

export function demoTagId(category: string, name: string): string {
  return `demo-tag-${category}-${name}`;
}

export function createDemoShots(projectId = 'demo-project'): WorkspaceShot[] {
  return DEMO_DEFINITIONS.map((definition, index) => ({
    id: `demo-shot-${String(index + 1).padStart(2, '0')}`,
    projectId,
    index: index + 1,
    startMs: definition.start,
    endMs: definition.end,
    durationMs: definition.end - definition.start,
    shotSize: definition.size,
    cameraMethod: definition.camera,
    dialogue: index === 5 ? '“这不对。”' : null,
    remark: DEMO_NOTES[index],
    tagIds: [
      demoTagId('景别', definition.size),
      demoTagId('运镜', normalizeCameraTag(definition.camera)),
      demoTagId('光线', '冷光'),
      demoTagId('声音', '对白'),
      demoTagId('剪辑', '硬切'),
    ],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    thumbnail: definition.image,
    title: definition.title,
    scene: definition.scene,
  }));
}

export function createDemoMarkers(shots: WorkspaceShot[]): TimelineMarker[] {
  return shots.flatMap((shot, index) => {
    const items: TimelineMarker[] = [
      {
        id: `demo-still-${shot.id}`,
        shotId: shot.id,
        timeMs: shot.startMs,
        type: 'still',
        label: `镜头 ${String(index + 1).padStart(2, '0')} 静帧`,
      },
    ];
    if (index % 2 === 1 || index === 5) {
      items.push({
        id: `demo-note-${shot.id}`,
        shotId: shot.id,
        timeMs: Math.round((shot.startMs + shot.endMs) / 2),
        type: 'note',
        label: `镜头 ${String(index + 1).padStart(2, '0')} 笔记`,
      });
    }
    return items;
  });
}

export function createDemoTerms(): DetailTerm[] {
  return [
    {
      id: 'term-close-up',
      category: '景别',
      term: '特写',
      definition: '以人物头部、手部或关键物件为主体，放大情绪与叙事信息。',
      builtin: true,
      sortOrder: 1,
      createdAt: CREATED_AT,
    },
    {
      id: 'term-push-in',
      category: '运镜',
      term: '缓推',
      definition: '摄影机缓慢接近主体，视线逐步收束，常用于积累情绪。',
      builtin: true,
      sortOrder: 2,
      createdAt: CREATED_AT,
    },
    {
      id: 'term-negative-space',
      category: '构图',
      term: '负空间',
      definition: '用大面积留白或暗部包围主体，形成孤立、压迫或未知感。',
      builtin: true,
      sortOrder: 3,
      createdAt: CREATED_AT,
    },
    {
      id: 'term-split-edit',
      category: '剪辑',
      term: '视线匹配',
      definition: '用人物视线方向连接前后镜头，使两个空间形成连续心理关系。',
      builtin: true,
      sortOrder: 4,
      createdAt: CREATED_AT,
    },
  ];
}

export function createDemoTags(): Tag[] {
  const tags: Tag[] = [];
  let sortOrder = 1;
  for (const group of DEFAULT_TAG_GROUPS) {
    for (const name of group.items) {
      tags.push({
        id: demoTagId(group.category, name),
        category: group.category,
        name,
        color: null,
        builtin: true,
        sortOrder: sortOrder++,
        createdAt: CREATED_AT,
      });
    }
  }
  return tags;
}

function normalizeCameraTag(camera: string): string {
  if (camera.includes('推')) return '推';
  if (camera.includes('拉')) return '拉';
  if (camera.includes('摇')) return '摇';
  if (camera.includes('跟') || camera.includes('移')) return '跟';
  if (camera.includes('手持')) return '手持';
  return '固定';
}

export const DEMO_PROJECT = {
  id: 'demo-project',
  name: 'Sword Art Online II · 01',
  subtitle: '示例拉片 · EP01',
  durationMs: 142_000,
};
