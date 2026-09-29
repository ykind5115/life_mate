-- ============================================================
-- 订正：0005 迁移把 event_time 平移错了方向
--
-- 我的错误（2026-09-29，发现于实施过程中）：
--   原值：`00:00:00Z`（UTC 零点，日期级事件的旧写法）
--   目标：`前一天 16:00:00Z`（= 北京当地零点，2026-09-29 00:00+08）
--   应该：减 8 小时
--   实际：**加了** 8 小时 → 成了 `08:00Z`（= 北京 16:00），比目标多 16 小时
--
-- 正确的换算（独立算式验证过）：
--   北京 2026-09-29 00:00 = UTC 2026-09-28 16:00
--   当前值                 = UTC 2026-09-29 08:00
--   需要                   = 当前值 − 16 小时
--
-- 安全性：
--   · 只动 event_precision='day' 的行 —— minute 精度的行没有这个问题
--   · 只动 events 表，不碰 messages / memories
--   · 行数可核对：本次应影响 11 行
-- ============================================================

BEGIN;

SELECT '订正前' AS 阶段, count(*) AS 行数 FROM events WHERE event_precision = 'day';

UPDATE "events"
   SET "event_time" = "event_time" - INTERVAL '16 hours'
 WHERE "event_precision" = 'day';

-- 核对：北京墙上时间应当正好是当地零点
SELECT title,
       (event_time AT TIME ZONE 'UTC')    AS utc_instant,
       (event_time AT TIME ZONE 'Asia/Shanghai') AS beijing_wall
FROM events
ORDER BY event_time DESC
LIMIT 5;

COMMIT;
