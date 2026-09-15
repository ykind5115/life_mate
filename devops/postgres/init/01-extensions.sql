-- LifeMate 数据库初始化
-- 仅在数据卷首次创建时执行一次
-- 对应《LifeMate 数据库设计 V1.1》§17.4 与 §18

-- 向量检索扩展（pgvector）
CREATE EXTENSION IF NOT EXISTS vector;

-- 关键词检索扩展
-- 中文场景下 PostgreSQL 默认全文检索不支持中文分词，
-- 因此混合检索的关键词通道使用 pg_trgm 的字符三元组匹配。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 通用工具
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 输出确认
DO $$
BEGIN
  RAISE NOTICE 'LifeMate extensions installed: vector=%, pg_trgm=%',
    (SELECT extversion FROM pg_extension WHERE extname = 'vector'),
    (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm');
END $$;
