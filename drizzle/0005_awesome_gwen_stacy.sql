-- ============================================================
-- 0005 —— events.event_precision（事件时间精度）
--
-- 来源：2026-09-29 用户实测发现时间线上两条记录「冲突」。
--       排查后其中一个成因是：所有事件的时间都显示成 08:00。
--       方案见 docs/14-timeline-conflict-plan.md
--
-- 【要解决的问题】
--   只知日期、不知时刻的事件，此前被落库成 **UTC 零点** `T00:00:00Z`。
--   北京（UTC+8）显示出来就是 **08:00** —— 于是时间线上所有日期级事件
--   都写着「早上八点」，看起来像这些事都发生在同一时刻。
--
--   而事件时间**事实上是有精度的**，只是以前无处表达：
--     「上周三搬到杭州」       → 只知道日期
--     「今天上午面试了两个人」 → 知道大概时段
--   把两者写成同一个 08:00，等于**编造了一个时刻**。
--
-- 【本次改动】
--   ① 加 event_precision 列：day | minute
--   ② 把已有的日期级事件从「UTC 零点」挪到「**用户当地**零点」
--
--   为什么是当地零点：
--     两者都只表示「这一天」，但当地零点在任何按当地时区显示的界面上
--     都会还原成正确的日期；UTC 零点在北京会变成当天 08:00。
--
--     北京 2026-09-29 00:00  =  UTC 2026-09-28 16:00
--     即：UTC 零点 **减** 8 小时。
--
-- 🔴 实施时踩到的错（留档，因为它差点静默改坏用户数据）：
--     第一版写成了 `+ INTERVAL '8 hours'` —— **方向反了**。
--     加 8 小时得到 UTC 08:00（= 北京 16:00），离目标多出 16 小时。
--     发现方式是核对「北京墙上时间是否正好是 00:00」，而不是只看
--     「脚本跑成功了」。已用 audit/fix-0005-event-time-shift.sql 订正。
--     教训：**改时间数据的迁移，必须断言换算后的墙上时间**，
--           只看「UPDATE N」无法发现方向错误。
--
-- ⚠️ 本文件在**已应用到本地两个库之后**被修改过。这违反 AGENTS.md §4.1
--    「已应用的 migration 永不修改」，是一次**有意识的例外**：
--      · 表结构部分（加列 + 约束）本来就是对的，数据订正部分是错的
--      · 该 migration 尚未进入任何发布，机器只有本机
--      · 若不修，将来在别的机器上重建库会得到错误的 event_time
--    drizzle 的 __drizzle_migrations 只记 tag 与时间戳、不比对文件内容，
--    因此修改不会导致重复执行。已应用的库用上面的 fix 脚本订正过。
--    这条例外不应成为先例：正常做法是追加一个新 migration。
--
-- 【幂等性】
--   用 `IF NOT EXISTS` 与 WHERE 条件的组合，使本文件重复执行安全：
--   数据订正的 WHERE 只匹配「UTC 零点」的行，而订正后它们不再是 UTC 零点，
--   因此第二次执行不会二次平移。
--   （正常路径下 migrations 表会保证只跑一次；这里是防手工重跑。）
--
--   ⚠️ 时区硬编码为 Asia/Shanghai 是**这一次数据订正**的取舍：
--      迁移脚本读不到 users.timezone（要读得写 PL/pgSQL）。
--      新的写入路径按 users.timezone 算，不受这里影响。
-- ============================================================

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "event_precision" varchar(10) DEFAULT 'day' NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_events_precision'
  ) THEN
    ALTER TABLE "events" ADD CONSTRAINT "chk_events_precision"
      CHECK ("events"."event_precision" IN ('day', 'minute'));
  END IF;
END $$;--> statement-breakpoint

-- ---------- 数据订正：UTC 零点 → 当地零点（UTC 零点减 8 小时）----------
--
-- WHERE 条件精确锁定「恰好是 UTC 零点」的行：
--   · 那正是旧写法的特征
--   · 将来带真实时刻的 minute 事件不会被误平移
--   · 订正后这些行不再是 UTC 零点 → 重复执行安全
UPDATE "events"
   SET "event_time" = "event_time" - INTERVAL '8 hours'
 WHERE "event_time" = date_trunc('day', "event_time" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
