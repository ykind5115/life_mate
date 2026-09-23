-- 诊断 pg_trgm 在中文短句上的实际表现
-- 上一轮 e2e 的检索诊断显示 keyword: 0，需要查清是阈值问题还是 pg_trgm 本身不行

\pset border 2

-- 1. 默认阈值
SHOW pg_trgm.similarity_threshold;

-- 2. 逐对相似度：查询词 vs 库里真实的记忆正文
SELECT q.q AS query,
       substring(m.content, 1, 30) AS memory,
       round(similarity(m.content, q.q)::numeric, 4) AS sim
  FROM memories m
  CROSS JOIN (VALUES
    ('我明年有什么打算'),
    ('我住在哪里'),
    ('我在学什么'),
    ('雅思'),
    ('搬家'),
    ('女朋友')
  ) AS q(q)
 WHERE m.status = 'active'
 ORDER BY q.q, sim DESC;

-- 3. 三元组分解：看中文被切成什么
SELECT show_trgm('我明年有什么打算') AS trgm_of_query;
SELECT show_trgm('用户的目标是年底能弹一首完整的钢琴曲') AS trgm_of_memory;
