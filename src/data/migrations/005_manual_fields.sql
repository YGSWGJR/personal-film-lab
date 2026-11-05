-- S41：字段级人工保护。记录用户手动编辑过的语义字段，
-- 供“保留人工标注”的标签应用策略精确保留。
ALTER TABLE shots ADD COLUMN manual_fields_json TEXT NOT NULL DEFAULT '[]';
