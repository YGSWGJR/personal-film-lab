-- S10：统一六类内置标签词表。
-- 仅移除 S08 阶段曾写入的旧内置词，不触碰用户自建标签。

DELETE FROM tags
WHERE builtin = 1
  AND (
    (category = '光线' AND name = '低照度')
    OR (category = '声音' AND name IN ('环境声', '静默'))
    OR (category = '剪辑' AND name IN ('跳切', '匹配剪辑'))
  );

INSERT INTO tags (id, category, name, color, builtin, sort_order, created_at) VALUES
  ('builtin-size-wide', '景别', '远景', NULL, 1, 1, '2026-10-24T00:00:00.000Z'),
  ('builtin-size-full', '景别', '全景', NULL, 1, 2, '2026-10-24T00:00:00.000Z'),
  ('builtin-size-medium', '景别', '中景', NULL, 1, 3, '2026-10-24T00:00:00.000Z'),
  ('builtin-size-close', '景别', '近景', NULL, 1, 4, '2026-10-24T00:00:00.000Z'),
  ('builtin-size-detail', '景别', '特写', NULL, 1, 5, '2026-10-24T00:00:00.000Z'),

  ('builtin-angle-front', '机位', '正面', NULL, 1, 1, '2026-10-24T00:00:00.000Z'),
  ('builtin-angle-side', '机位', '侧面', NULL, 1, 2, '2026-10-24T00:00:00.000Z'),
  ('builtin-angle-over-shoulder', '机位', '过肩', NULL, 1, 3, '2026-10-24T00:00:00.000Z'),
  ('builtin-angle-high', '机位', '俯拍', NULL, 1, 4, '2026-10-24T00:00:00.000Z'),
  ('builtin-angle-low', '机位', '仰拍', NULL, 1, 5, '2026-10-24T00:00:00.000Z'),

  ('builtin-move-static', '运镜', '固定', NULL, 1, 1, '2026-10-24T00:00:00.000Z'),
  ('builtin-move-push', '运镜', '推', NULL, 1, 2, '2026-10-24T00:00:00.000Z'),
  ('builtin-move-pull', '运镜', '拉', NULL, 1, 3, '2026-10-24T00:00:00.000Z'),
  ('builtin-move-pan', '运镜', '摇', NULL, 1, 4, '2026-10-24T00:00:00.000Z'),
  ('builtin-move-follow', '运镜', '跟', NULL, 1, 5, '2026-10-24T00:00:00.000Z'),
  ('builtin-move-handheld', '运镜', '手持', NULL, 1, 6, '2026-10-24T00:00:00.000Z'),

  ('builtin-light-natural', '光线', '自然光', NULL, 1, 1, '2026-10-24T00:00:00.000Z'),
  ('builtin-light-cool', '光线', '冷光', NULL, 1, 2, '2026-10-24T00:00:00.000Z'),
  ('builtin-light-back', '光线', '逆光', NULL, 1, 3, '2026-10-24T00:00:00.000Z'),
  ('builtin-light-hard', '光线', '硬光', NULL, 1, 4, '2026-10-24T00:00:00.000Z'),

  ('builtin-sound-dialogue', '声音', '对白', NULL, 1, 1, '2026-10-24T00:00:00.000Z'),
  ('builtin-sound-ambience', '声音', '环境', NULL, 1, 2, '2026-10-24T00:00:00.000Z'),
  ('builtin-sound-music', '声音', '音乐', NULL, 1, 3, '2026-10-24T00:00:00.000Z'),
  ('builtin-sound-silence', '声音', '无声', NULL, 1, 4, '2026-10-24T00:00:00.000Z'),

  ('builtin-edit-hard-cut', '剪辑', '硬切', NULL, 1, 1, '2026-10-24T00:00:00.000Z'),
  ('builtin-edit-dissolve', '剪辑', '叠化', NULL, 1, 2, '2026-10-24T00:00:00.000Z'),
  ('builtin-edit-flash', '剪辑', '闪白', NULL, 1, 3, '2026-10-24T00:00:00.000Z')
ON CONFLICT(category, name) DO UPDATE SET
  builtin = 1,
  sort_order = excluded.sort_order;
