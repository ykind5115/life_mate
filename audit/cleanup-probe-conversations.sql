-- ============================================================
-- 清理「可观测性验证」期间产生的测试会话
--
-- 背景：2026-09-29 做 docs/13 §6.1（P0 验证轨迹落库）时，
--       audit/probe-log-leak.ts 的早期版本会建会话，脚本改了几轮
--       （每次修断言就跑一遍），于是在开发库里留下 7 条空会话：
--         · 2 条 title='probe'（探针直接 insert 的）
--         · 5 条 title='[已删除的对话]'、status=deleted
--           （探针脚本结尾的清理只删了消息，会话行留了下来）
--       再加上本轮真实自检那 1 条。
--
-- 🔴 安全性：**按 id 精确删除**，不用时间范围、不用 title 匹配。
--    时间范围会误伤用户在这段时间里说过的话；title 匹配更是危险
--    （用户自己的会话也可能叫 probe）。
--
--    这 7 个 id 已逐个核对过：全部 0 条消息、全部产生于测试期间、
--    用户真实会话（面试招人别急着定 等 5 条）不在其中。
--
-- 为什么用硬删除而不是走 API 的软删除：
--    这些会话**本来就是空的**（0 条消息），软删除只会让列表里
--    多一行「[已删除的对话]」占位 —— 那正是现在的问题。
--    它们没有任何派生数据（无消息 → 无来源 → 无派生记忆），
--    硬删除不违反 §24 的任何承诺。
-- ============================================================

BEGIN;

-- 先确认这 7 条里没有一条带着消息：带消息就中止，避免误删真实内容
DO $$
DECLARE
  msg_count int;
BEGIN
  SELECT count(*) INTO msg_count
  FROM messages
  WHERE conversation_id IN (
    '5730b9f4-ba21-4325-826c-51a59da51a1d',
    'd030a200-16c2-462b-8be6-b4cbb448f3e1',
    '094db74b-3437-4830-bdc1-6858171fcaa0',
    '0785dfb8-1122-4ee2-8e56-92a05a450aea',
    'b6ae9a7b-2e79-43ff-92aa-f7485eb4e265',
    'ba1107d2-f652-47d3-b9b2-27ab64a2fcbe',
    '8776509c-aeda-4a31-b393-5fd3d9338b1e'
  );

  IF msg_count > 0 THEN
    RAISE EXCEPTION '这 7 条会话里还留着 % 条消息，中止清理（可能选错了目标）', msg_count;
  END IF;
END $$;

-- 摘要（正常情况为 0 行）
DELETE FROM conversation_summaries
WHERE conversation_id IN (
  '5730b9f4-ba21-4325-826c-51a59da51a1d',
  'd030a200-16c2-462b-8be6-b4cbb448f3e1',
  '094db74b-3437-4830-bdc1-6858171fcaa0',
  '0785dfb8-1122-4ee2-8e56-92a05a450aea',
  'b6ae9a7b-2e79-43ff-92aa-f7485eb4e265',
  'ba1107d2-f652-47d3-b9b2-27ab64a2fcbe',
  '8776509c-aeda-4a31-b393-5fd3d9338b1e'
);

-- 消息（上面已断言为 0 条，这里是为了完整性）
DELETE FROM messages
WHERE conversation_id IN (
  '5730b9f4-ba21-4325-826c-51a59da51a1d',
  'd030a200-16c2-462b-8be6-b4cbb448f3e1',
  '094db74b-3437-4830-bdc1-6858171fcaa0',
  '0785dfb8-1122-4ee2-8e56-92a05a450aea',
  'b6ae9a7b-2e79-43ff-92aa-f7485eb4e265',
  'ba1107d2-f652-47d3-b9b2-27ab64a2fcbe',
  '8776509c-aeda-4a31-b393-5fd3d9338b1e'
);

-- 会话本体
DELETE FROM conversations
WHERE id IN (
  '5730b9f4-ba21-4325-826c-51a59da51a1d',
  'd030a200-16c2-462b-8be6-b4cbb448f3e1',
  '094db74b-3437-4830-bdc1-6858171fcaa0',
  '0785dfb8-1122-4ee2-8e56-92a05a450aea',
  'b6ae9a7b-2e79-43ff-92aa-f7485eb4e265',
  'ba1107d2-f652-47d3-b9b2-27ab64a2fcbe',
  '8776509c-aeda-4a31-b393-5fd3d9338b1e'
);

COMMIT;
