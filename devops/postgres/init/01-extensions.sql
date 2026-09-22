-- LifeMate 数据库初始化
-- 仅在数据卷首次创建时执行一次
-- 对应《LifeMate 数据库设计 V1.1》§7、§11.3.2、§17.4 与 §18
--
-- ⚠️ 本脚本只在「数据卷为空」时执行。
--    对已经存在数据的库补扩展，必须写进 Migration —— 改这里不会生效。

-- 向量检索扩展（pgvector）
CREATE EXTENSION IF NOT EXISTS vector;

-- 关键词检索扩展
-- 中文场景下 PostgreSQL 默认全文检索不支持中文分词，
-- 因此混合检索的关键词通道使用 pg_trgm 的字符三元组匹配。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 区间排他约束所需
-- extraction_runs 的 excl_extraction_range 用 EXCLUDE 保证「成功区间不重叠」，
-- 其等值部分（conversation_id）需要 uuid 的 GiST 操作符类，由 btree_gist 提供。
-- 缺少本扩展时该约束无法创建，见《数据库设计 V1.1》§11.3.2。
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 不需要 uuid-ossp：所有主键使用 gen_random_uuid()，PostgreSQL 13+ 内置（见 §7）。

-- 输出确认
DO $$
BEGIN
  RAISE NOTICE 'LifeMate extensions installed: vector=%, pg_trgm=%, btree_gist=%',
    (SELECT extversion FROM pg_extension WHERE extname = 'vector'),
    (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'),
    (SELECT extversion FROM pg_extension WHERE extname = 'btree_gist');
END $$;
