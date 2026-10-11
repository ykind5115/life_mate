/**
 * LifeMate 前端（docs/16 前端改版）
 *
 * 【架构】
 *   一个 hash 路由 + 每个视图一个模块（render 函数 + store）。
 *   基础设施在 core.js（h / createStore / 路由 / 格式化 / toast）。
 *   视觉系统在 app.css（全部走 CSS 变量）。
 *   为什么不上框架见 docs/16 决策 A 与 core.js 的文件头。
 *
 * 【这一版把后端已就绪、前端没用上的功能全部接上了】
 *   记忆冲突裁决（此前 23 条完全无法处理）、记忆详情与来源追溯、
 *   知识图谱、人际关系（表建了很久但没有 API）、手工补录时间线、
 *   改会话标题、四个偏好设置、改时区、自定义回顾区间、
 *   Agent 执行轨迹（此前 91 条数据但 API 把 metadata 丢了）、
 *   会话派生记忆、记忆状态概览。
 *
 * 【安全口径】
 *   · 所有用户内容（记忆正文、人名、会话标题…）经 h() 走 textContent
 *   · **唯一**用 innerHTML 的地方是消息与回顾正文，且必须先过
 *     renderMarkdown()（它先整体转义再加标签，见 markdown.js）
 *   · 这是「让危险写法变成更麻烦的写法」的取舍
 */
import {
  h,
  render,
  createStore,
  onRouteChange,
  navigate,
  formatDate,
  formatDateTime,
  formatEventTime,
  formatRelative,
  formatNumber,
  formatDuration,
  debounce,
  toast,
} from './core.js';
import { renderMarkdown } from './markdown.js';

const API = '/api/v1';

// ============================================================
// HTTP
// ============================================================

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    const message = json?.error?.message ?? `请求失败（HTTP ${res.status}）`;
    const err = new Error(message);
    err.status = res.status;
    err.details = json?.error?.details;
    throw err;
  }

  return json.data ?? json;
}

/** 写操作统一带提示 —— 失败必须被看见，否则用户会以为生效了 */
async function tryApi(method, path, body, okMessage) {
  try {
    const result = await api(method, path, body);
    if (okMessage) toast(okMessage, 'success');
    return result;
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

// ============================================================
// 全局状态
// ============================================================

const shell = createStore({
  route: 'chat',
  /** 记忆状态分布。导航上的「待裁决」徽标也用它 */
  overview: null,
  health: 'checking',
});

async function refreshOverview() {
  try {
    shell.set({ overview: await api('GET', '/memories/overview') });
  } catch {
    // 概览拿不到不影响使用，它只是徽标
  }
}

async function checkHealth() {
  try {
    const res = await fetch('/health', { signal: AbortSignal.timeout(4000) });
    shell.set({ health: res.ok ? 'ok' : 'bad' });
  } catch {
    shell.set({ health: 'bad' });
  }
}

// ============================================================
// 共用片段
// ============================================================

const MEMORY_TYPE_LABEL = {
  fact: '事实',
  preference: '偏好',
  event: '事件',
  goal: '目标',
  relationship: '关系',
  state: '状态',
};

const MEMORY_STATUS_META = {
  active: { label: '当前有效', cls: 'ok' },
  conflict: { label: '待裁决', cls: 'warn' },
  superseded: { label: '已被替代', cls: '' },
  archived: { label: '已归档', cls: '' },
  rejected: { label: '已否定', cls: 'danger' },
  deleted: { label: '已删除', cls: 'danger' },
};

const GOAL_STATUS_LABEL = {
  active: '进行中',
  paused: '已搁置',
  completed: '已完成',
  cancelled: '已放弃',
  archived: '已归档',
};

const EVENT_CATEGORY_LABEL = {
  work: '工作',
  study: '学习',
  project: '项目',
  life: '生活',
  health: '健康',
  other: '其他',
};

const RELATION_TYPE_LABEL = {
  family: '家人',
  friend: '朋友',
  colleague: '同事',
  mentor: '前辈',
  partner: '伴侣',
  classmate: '同学',
};

function tag(text, cls) {
  return h('span', { class: `tag ${cls ?? ''}`.trim() }, text);
}

function memoryStatusTag(status) {
  const meta = MEMORY_STATUS_META[status] ?? { label: status, cls: '' };
  return tag(meta.label, meta.cls);
}

function typeTag(type) {
  return tag(MEMORY_TYPE_LABEL[type] ?? type, 'accent');
}

/** 空状态给出下一步做什么，而不是一句冷冰冰的「没有数据」 */
function emptyState(title, hint) {
  return h('div', { class: 'empty' }, h('p', {}, title), ...(hint ? [h('p', { class: 'dim' }, hint)] : []));
}

function loadingRows(n = 4) {
  return h(
    'div',
    {},
    ...Array.from({ length: n }, () =>
      h('div', { class: 'card' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: { width: '62%' } }))
    )
  );
}

function errorBox(err, retry) {
  return h(
    'div',
    { class: 'empty' },
    h('p', {}, `加载失败：${err.message}`),
    ...(retry ? [h('p', {}, h('button', { class: 'btn small', onclick: retry }, '重试'))] : [])
  );
}

// ============================================================
// 抽屉
// ============================================================

let drawerHost = null;

function closeDrawer() {
  if (drawerHost) {
    drawerHost.remove();
    drawerHost = null;
  }
}

/**
 * 右侧抽屉。
 *
 * 【为什么用抽屉而不是新页面】详情与列表是同一件事的两个粒度 ——
 * 抽屉让用户随时关掉回到列表，不丢滚动位置。
 */
function openDrawer(title, bodyNode, actions) {
  closeDrawer();

  const body = h('div', { class: 'drawer-body' }, bodyNode);
  const panel = h(
    'div',
    { class: 'drawer' },
    h(
      'div',
      { class: 'drawer-head' },
      h('h2', {}, title),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } }, ...(actions ?? [])),
      h('button', { class: 'btn icon', title: '关闭', onclick: closeDrawer }, '✕')
    ),
    body
  );

  const mask = h('div', { class: 'drawer-mask', onclick: closeDrawer });
  drawerHost = h('div', {}, mask, panel);
  document.body.appendChild(drawerHost);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);

  return body;
}

// ============================================================
// 对话页
// ============================================================

const chat = createStore({
  conversations: [],
  activeId: null,
  detail: null,
  messages: [],
  memories: [],
  loading: false,
  streaming: false,
});

async function loadConversations() {
  const data = await api('GET', '/conversations?page_size=50');
  chat.set({ conversations: data.items });
}

async function openConversation(id, opts = {}) {
  chat.set({ activeId: id, loading: true, detail: null, messages: [], memories: [] });
  if (!opts.silent) navigate(`chat/${id}`);

  try {
    const detail = await api('GET', `/conversations/${id}`);
    chat.set({ detail, messages: detail.messages ?? [], loading: false });
    renderMessages();

    // 派生记忆单独拉 —— 它失败不该影响看对话
    try {
      const mem = await api('GET', `/conversations/${id}/memories`);
      chat.set({ memories: mem.items ?? [] });
    } catch {
      chat.set({ memories: [] });
    }
    renderConvSide();
    renderConversations();
  } catch (err) {
    chat.set({ loading: false });
    render(document.getElementById('messages'), errorBox(err, () => openConversation(id)));
  }
}

function newChat() {
  closeDrawer();
  chat.set({ activeId: null, detail: null, messages: [], memories: [] });
  navigate('chat');
  renderMessages();
  renderConversations();
  renderConvSide();
  document.getElementById('input')?.focus();
}

function renderConversations() {
  const box = document.getElementById('conversations');
  if (!box) return;
  /**
   * ⚠️ conversations 在 store 初始化时是空数组，但首屏有个时序问题：
   *    showView('chat') 会在 loadConversations() 之前跑一次
   *    （boot → onRouteChange → showView），那一刻它还是初始值。
   *
   *    实测踩到：`Cannot read properties of undefined (reading 'length')`
   *    → 首屏渲染成一个「加载失败」框，而数据其实马上就回来了。
   *    因此这里必须容错，不能假设它已经是数组。
   */
  const { conversations = [], activeId } = chat.get();

  if (conversations.length === 0) {
    render(box, h('div', { class: 'dim', style: { padding: '12px' } }, '还没有聊过。'));
    return;
  }

  render(
    box,
    ...conversations.map((c) =>
      h(
        'div',
        {
          class: `conv-item ${c.id === activeId ? 'active' : ''}`,
          onclick: () => openConversation(c.id),
        },
        h('div', { class: 'conv-title' }, c.title ?? '（无标题）'),
        h('div', { class: 'conv-meta' }, `${c.message_count ?? 0} 条 · ${formatRelative(c.last_message_at ?? c.created_at)}`),
        h(
          'div',
          { class: 'conv-actions' },
          h(
            'button',
            {
              class: 'btn icon',
              title: '改标题',
              onclick: (e) => {
                e.stopPropagation();
                renameConversation(c);
              },
            },
            '✎'
          ),
          h(
            'button',
            {
              class: 'btn icon',
              title: '删除',
              onclick: (e) => {
                e.stopPropagation();
                deleteConversation(c);
              },
            },
            '🗑'
          )
        )
      )
    )
  );
}

/** 改会话标题（此前前端没有入口） */
function renameConversation(c) {
  const input = h('input', { class: 'input', value: c.title ?? '', maxlength: '200' });
  const save = h(
    'button',
    {
      class: 'btn primary small',
      onclick: async () => {
        const title = input.value.trim();
        if (title.length === 0) {
          toast('标题不能为空', 'error');
          return;
        }
        await tryApi('PATCH', `/conversations/${c.id}`, { title }, '标题已改');
        closeDrawer();
        await loadConversations();
        renderConversations();
        const d = chat.get().detail;
        if (d && chat.get().activeId === c.id) chat.set({ detail: { ...d, title } });
      },
    },
    '保存'
  );

  openDrawer('改标题', h('div', {}, h('label', {}, '标题', input)), [save]);
  input.focus();
  input.select();
}

/**
 * 删除会话。
 *
 * 两种语义必须在界面上分清（AGENTS.md §6 记的未解决项）：
 *   默认只清聊天列表，派生记忆保留；
 *   勾选后会连失去全部来源的记忆一起删 —— 不可逆。
 */
function deleteConversation(c) {
  const withMemories = h('input', { type: 'checkbox' });
  openDrawer(
    '删除会话',
    h(
      'div',
      {},
      h('p', {}, `要删除「${c.title ?? '（无标题）'}」吗？`),
      h('p', { class: 'dim' }, '删除后聊天记录会被清空，不能恢复。'),
      h(
        'label',
        { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '16px' } },
        withMemories,
        h(
          'span',
          {},
          '同时删除这段对话派生出的记忆',
          h('div', { class: 'dim' }, '不勾选则保留记忆（只清聊天列表）。勾选是不可逆的。')
        )
      )
    ),
    [
      h(
        'button',
        {
          class: 'btn danger small',
          onclick: async () => {
            const qs = withMemories.checked ? '?delete_derived_memories=true' : '';
            await tryApi('DELETE', `/conversations/${c.id}${qs}`, undefined, '已删除');
            closeDrawer();
            if (chat.get().activeId === c.id) newChat();
            await loadConversations();
            renderConversations();
            refreshOverview();
          },
        },
        '删除'
      ),
    ]
  );
}

function daySeparator(iso) {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const isYesterday = d.toDateString() === new Date(today.getTime() - 86400000).toDateString();
  const label = isToday ? '今天' : isYesterday ? '昨天' : formatDate(iso);
  return h('div', { class: 'day-sep' }, label);
}

function renderMessages() {
  const box = document.getElementById('messages');
  if (!box) return;
  const { messages = [], loading, detail } = chat.get();

  if (loading) {
    render(box, loadingRows(3));
    return;
  }

  if (detail?.deleted_at) {
    render(box, emptyState('这段对话已删除', '消息已清空，不能再恢复。列表里保留它只是为了让你知道这里曾经有过一段对话。'));
    return;
  }

  if (messages.length === 0) {
    render(box, emptyState('聊点什么吧。', '你说的话会被后台整理成长期记忆，下次相关的时候它会自己想起来。'));
    return;
  }

  const nodes = [];
  let lastDay = '';
  for (const m of messages) {
    const day = formatDate(m.created_at);
    if (day && day !== lastDay) {
      nodes.push(daySeparator(m.created_at));
      lastDay = day;
    }
    nodes.push(messageNode(m));
  }

  render(box, ...nodes);
  box.scrollTop = box.scrollHeight;
}

function messageNode(m) {
  const isUser = m.role === 'user';

  const content = h('div', { class: 'msg-content' });
  if (isUser) {
    // 用户自己的话原样显示 —— 他写什么就显示什么
    content.textContent = m.content;
  } else {
    /**
     * ⚠️ 全站唯一用 innerHTML 的地方之一。
     *    renderMarkdown 先整体转义再加标签（见 markdown.js 的文件头），
     *    因此输入即使是 <script> 也只会显示成文本。
     */
    content.innerHTML = renderMarkdown(m.content);
  }

  return h(
    'div',
    { class: `msg ${isUser ? 'user' : 'assistant'}` },
    h('div', { class: 'msg-avatar' }, isUser ? '你' : 'LM'),
    h(
      'div',
      { class: 'msg-body' },
      h(
        'div',
        { class: 'msg-who' },
        isUser ? '你' : 'LifeMate',
        h('span', { class: 'dim' }, formatDateTime(m.created_at).slice(11)),
        h(
          'div',
          { class: 'msg-tools' },
          h(
            'button',
            {
              class: 'btn icon',
              title: '复制',
              onclick: () => {
                navigator.clipboard?.writeText(m.content).then(
                  () => toast('已复制', 'success'),
                  () => toast('复制失败', 'error')
                );
              },
            },
            '⧉'
          ),
          h('button', { class: 'btn icon', title: '看这段回答是怎么来的', onclick: () => showTraceDrawer(m) }, '◎')
        )
      ),
      content,
      ...(m.metadata ? [tracePanel(m.metadata)] : [])
    )
  );
}

/**
 * 轨迹面板（折叠）。
 *
 * 【默认收起的取舍】轨迹是「想深究时能看」的东西，不是每轮都要看的 ——
 * 常驻展开会让对话淹没在元信息里。
 * 但它必须存在：09-29 那次幻觉排查时唯一缺的就是「这一轮到底查了什么」，
 * 而库里早有 91 条带轨迹的消息，只是 API 把它们丢了。
 */
function tracePanel(metadata) {
  const a = metadata.agent;
  if (!a) return h('span');

  const kv = (k, v) => h('div', { class: 'trace-kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, String(v)));

  const grid = h(
    'div',
    { class: 'trace-grid' },
    kv('模型', a.model ?? '—'),
    kv('提示词版本', a.promptVersion ?? '—'),
    kv('轮数', a.iterations ?? '—'),
    kv('工具调用', a.toolCallsExecuted ?? 0),
    ...(a.usage ? [kv('输入 token', formatNumber(a.usage.inputTokens ?? 0)), kv('输出 token', formatNumber(a.usage.outputTokens ?? 0))] : []),
    ...(a.usage?.reasoningTokens ? [kv('思考 token', formatNumber(a.usage.reasoningTokens))] : []),
    ...(a.timingsMs?.agentTotal !== undefined ? [kv('总耗时', formatDuration(a.timingsMs.agentTotal))] : []),
    ...(a.timingsMs?.retrieval !== undefined ? [kv('检索耗时', formatDuration(a.timingsMs.retrieval))] : []),
    ...(a.context ? [kv('历史消息', a.context.historyCount ?? 0), kv('注入记忆', a.context.injectedMemoryCount ?? 0)] : []),
    ...(a.context?.approxTokens !== undefined ? [kv('上下文 token', formatNumber(a.context.approxTokens))] : [])
  );

  const sections = [grid];

  if (a.retrieval) {
    const r = a.retrieval;
    sections.push(
      h(
        'div',
        { class: 'trace-section' },
        h('div', { class: 't' }, '检索'),
        h(
          'div',
          { class: 'trace-grid' },
          kv('是否执行', r.performed ? '是' : `否（${r.skippedReason ?? '未知原因'}）`),
          ...(r.channelHits ? [kv('向量 / 关键词 / 槽位', `${r.channelHits.vector} / ${r.channelHits.keyword} / ${r.channelHits.slot}`)] : []),
          ...(r.fusedCount !== undefined ? [kv('融合后', r.fusedCount)] : []),
          ...(r.returned !== undefined ? [kv('最终返回', r.returned)] : [])
        ),
        ...(r.degradations?.length ? [h('div', { class: 'trace-chips' }, ...r.degradations.map((d) => tag(d, 'warn')))] : [])
      )
    );
  }

  if (a.injectedMemories?.length) {
    sections.push(
      h(
        'div',
        { class: 'trace-section' },
        h('div', { class: 't' }, `注入了 ${a.injectedMemories.length} 条记忆`),
        h(
          'div',
          { class: 'trace-chips' },
          ...a.injectedMemories.map((m) =>
            h(
              'span',
              {
                class: 'tag',
                style: { cursor: 'pointer' },
                title: `${m.type} · 得分 ${m.score?.toFixed?.(3) ?? '—'}`,
                onclick: () => showMemoryDrawer(m.id),
              },
              `${m.type} ${String(m.id).slice(0, 4)} · ${m.score?.toFixed?.(2) ?? '—'}`
            )
          )
        )
      )
    );
  }

  if (a.toolCalls?.length) {
    sections.push(
      h(
        'div',
        { class: 'trace-section' },
        h('div', { class: 't' }, '工具调用'),
        ...a.toolCalls.map((t) =>
          h(
            'div',
            { style: { marginBottom: '4px' } },
            h('span', { class: 'tag info' }, t.name),
            ' ',
            // 参数只记了**键名**，值不在轨迹里（§16.2 禁止正文副本进 JSONB）
            h('span', { class: 'dim' }, `参数键：${(t.argumentKeys ?? []).join(', ') || '（无）'}`),
            t.resultChars !== undefined ? h('span', { class: 'dim' }, ` · 返回 ${formatNumber(t.resultChars)} 字`) : null,
            t.truncated ? h('span', { class: 'dim' }, ' · 被截断') : null,
            t.error ? h('span', { class: 'dim' }, ` · ${t.error}`) : null
          )
        )
      )
    );
  }

  return h(
    'details',
    { class: 'trace' },
    h('summary', {}, `这一轮是怎么来的${a.timingsMs?.agentTotal !== undefined ? ` · ${formatDuration(a.timingsMs.agentTotal)}` : ''}`),
    h('div', { class: 'trace-body' }, ...sections)
  );
}

function showTraceDrawer(m) {
  openDrawer(
    '这一轮的来龙去脉',
    m.metadata ? h('div', {}, tracePanel(m.metadata)) : h('p', {}, '这一轮没有留下轨迹（改版前的消息没有记录）。')
  );
}

/** 右栏：本会话派生出的记忆 */
function renderConvSide() {
  const box = document.getElementById('chat-side');
  if (!box) return;
  const { memories = [], activeId } = chat.get();

  if (!activeId) {
    render(box);
    return;
  }

  render(
    box,
    h('div', { class: 'dim', style: { marginBottom: '10px' } }, `这段对话它记住了 ${memories.length} 条`),
    ...(memories.length === 0
      ? [h('p', { class: 'dim' }, '还没有整理出记忆。多说几句，后台整理完就会出现。')]
      : memories.map((m) =>
          h(
            'div',
            { class: 'card', style: { cursor: 'pointer', padding: '10px 12px' }, onclick: () => showMemoryDrawer(m.id) },
            h('div', { class: 'mem-head' }, typeTag(m.type), ...(m.status !== 'active' ? [memoryStatusTag(m.status)] : [])),
            h('div', { style: { fontSize: 'var(--fs-sm)', lineHeight: '1.5' } }, m.content),
            m.valid_from ? h('div', { class: 'dim', style: { marginTop: '5px' } }, `${formatDate(m.valid_from)} 起`) : null
          )
        ))
  );
}

/** 流式发送 */
async function sendMessage(text) {
  const { activeId } = chat.get();
  if (chat.get().streaming) return;
  chat.set({ streaming: true });

  const box = document.getElementById('messages');
  const userNode = messageNode({ role: 'user', content: text, created_at: new Date().toISOString() });
  const assistantContent = h('div', { class: 'msg-content' }, h('span', { class: 'cursor' }));
  const assistantNode = h(
    'div',
    { class: 'msg assistant' },
    h('div', { class: 'msg-avatar' }, 'LM'),
    h('div', { class: 'msg-body' }, h('div', { class: 'msg-who' }, 'LifeMate'), assistantContent)
  );

  if (box.querySelector('.empty')) box.replaceChildren();
  box.appendChild(userNode);
  box.appendChild(assistantNode);
  box.scrollTop = box.scrollHeight;

  let buffer = '';
  let newConversationId = activeId;

  try {
    const res = await fetch(`${API}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, ...(activeId ? { conversation_id: activeId } : {}) }),
    });

    if (!res.ok || !res.body) {
      const raw = await res.text();
      let msg = `请求失败（HTTP ${res.status}）`;
      try {
        msg = JSON.parse(raw)?.error?.message ?? msg;
      } catch {
        /* 保持默认文案 */
      }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      // SSE：事件以空行分隔
      const blocks = pending.split('\n\n');
      pending = blocks.pop() ?? '';

      for (const block of blocks) {
        let eventName = 'message';
        let dataLine = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;

        let payload;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }

        if (eventName === 'token') {
          buffer += payload.token ?? payload.text ?? '';
          assistantContent.innerHTML = `${renderMarkdown(buffer)}<span class="cursor"></span>`;
          box.scrollTop = box.scrollHeight;
        } else if (eventName === 'done' || eventName === 'end') {
          if (payload.conversation_id) newConversationId = payload.conversation_id;
          if (payload.reply) buffer = payload.reply;
        } else if (eventName === 'error') {
          throw new Error(payload.message ?? '生成失败');
        }
      }
    }

    assistantContent.innerHTML = renderMarkdown(buffer || '（没有内容）');
    box.scrollTop = box.scrollHeight;

    // 重新拉一次，让轨迹与新会话 id 落到界面上
    await loadConversations();
    if (newConversationId) {
      await openConversation(newConversationId, { silent: true });
      navigate(`chat/${newConversationId}`);
    }
    renderConversations();
    refreshOverview();
  } catch (err) {
    assistantContent.textContent = `出错了：${err.message}`;
    toast(err.message, 'error');
  } finally {
    chat.set({ streaming: false });
  }
}

function renderChatView() {
  renderConversations();
  renderMessages();
  renderConvSide();
}

// ============================================================
// 记忆页
// ============================================================

const memories = createStore({ items: [], overview: null, view: 'current', q: '', loading: false });

async function loadMemories() {
  const { view, q } = memories.get();
  memories.set({ loading: true });
  const listBox = document.getElementById('mem-list');
  if (listBox) render(listBox, loadingRows(5));

  try {
    const data =
      q.trim().length > 0
        ? await api('GET', `/memories/search?q=${encodeURIComponent(q.trim())}&limit=30`)
        : await api('GET', `/memories?page_size=50&view=${view}`);
    memories.set({ items: data.items ?? data.memories ?? [], loading: false });
  } catch (err) {
    memories.set({ loading: false, items: [] });
    if (listBox) render(listBox, errorBox(err, loadMemories));
    return;
  }

  const overview = await api('GET', '/memories/overview').catch(() => null);
  if (overview) {
    memories.set({ overview });
    shell.set({ overview });
  }
  renderMemories();
}

/** 状态概览卡片 —— 点一下按该状态过滤 */
function overviewRow(overview) {
  const stats = [
    { label: '当前有效', n: overview.current, view: 'current' },
    { label: '待裁决', n: overview.conflict, view: 'management', hot: overview.conflict > 0 },
    { label: '已被替代', n: overview.superseded, view: 'management' },
    { label: '已归档', n: overview.archived, view: 'management' },
    { label: '已否定', n: overview.rejected, view: 'management' },
    { label: '未删除合计', n: overview.total, view: 'management' },
  ];

  return h(
    'div',
    { class: 'stat-row' },
    ...stats.map((s) =>
      h(
        'div',
        {
          class: `stat clickable ${s.hot ? 'hot' : ''}`,
          onclick: () => {
            memories.set({ view: s.view, q: '' });
            const viewSel = document.getElementById('mem-view');
            if (viewSel) viewSel.value = s.view;
            const searchInput = document.getElementById('mem-search');
            if (searchInput) searchInput.value = '';
            loadMemories();
          },
        },
        h('div', { class: 'n' }, formatNumber(s.n)),
        h('div', { class: 'l' }, s.label)
      )
    )
  );
}

function renderMemories() {
  const box = document.getElementById('mem-list');
  if (!box) return;
  const { items = [], overview, q, loading } = memories.get();

  if (loading) {
    render(box, loadingRows(5));
    return;
  }

  const nodes = [];
  if (overview) nodes.push(overviewRow(overview));

  if (q.trim().length > 0) {
    // 说明它是语义搜索 —— 结果可能包含字面不匹配但意思相近的记忆
    nodes.push(h('div', { class: 'dim', style: { marginBottom: '10px' } }, `语义搜索结果（${items.length} 条）—— 包含意思相近但不完全匹配字面的记忆`));
  }

  if (items.length === 0) {
    nodes.push(
      q.trim().length > 0
        ? emptyState('没有找到相关的记忆', '换个说法试试，它是按意思找的。')
        : emptyState('这里还没有记忆', '去对话里聊点什么，后台会陆续整理出记忆。')
    );
  } else {
    /**
     * 待裁决的排最前面 —— 它们是「需要你动手」的东西，
     * 埋在一堆 active 里等于没有。
     */
    const rank = (m) => (m.status === 'conflict' ? 0 : m.status === 'active' ? 1 : 2);
    nodes.push(...[...items].sort((a, b) => rank(a) - rank(b)).map(memoryItem));
  }

  render(box, ...nodes);
}

function memoryItem(m) {
  return h(
    'div',
    { class: `mem-item ${m.status}`, onclick: () => showMemoryDrawer(m.id) },
    h(
      'div',
      { class: 'mem-head' },
      typeTag(m.type),
      memoryStatusTag(m.status),
      ...(m.predicate_key ? [h('span', { class: 'dim', style: { fontFamily: 'var(--font-mono)' } }, m.predicate_key)] : []),
      h('span', { class: 'dim', style: { marginLeft: 'auto' } }, formatDate(m.valid_from ?? m.created_at))
    ),
    h('div', { class: 'mem-content' }, m.content),
    h(
      'div',
      { class: 'mem-foot' },
      h('span', {}, `重要度 ${(m.importance_score ?? 0).toFixed(2)}`),
      m.source_count ? h('span', {}, `${m.source_count} 个来源`) : null,
      h(
        'div',
        { class: 'mem-actions' },
        // 「这条不对」放在列表上 —— 23 条待裁决要求逐条点进详情是不现实的
        m.status === 'conflict'
          ? h('button', { class: 'btn small', onclick: (e) => (e.stopPropagation(), showConflictDrawer(m.id)) }, '去裁决')
          : null,
        m.status === 'active'
          ? h(
              'button',
              {
                class: 'btn small',
                title: '标为「这条不对」',
                onclick: async (e) => {
                  e.stopPropagation();
                  await tryApi('POST', `/memories/${m.id}/reject`, undefined, '已标记为不对');
                  loadMemories();
                },
              },
              '这条不对'
            )
          : null,
        m.status === 'rejected'
          ? h(
              'button',
              {
                class: 'btn small',
                onclick: async (e) => {
                  e.stopPropagation();
                  await tryApi('POST', `/memories/${m.id}/restore`, undefined, '已恢复');
                  loadMemories();
                },
              },
              '撤回'
            )
          : null
      )
    )
  );
}

/** 记忆详情：正文 + 槽位 + 状态流转 + 来源（可跳回对话原文） */
async function showMemoryDrawer(id) {
  const body = openDrawer('记忆详情', h('div', {}, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));

  try {
    const [m, sources] = await Promise.all([
      api('GET', `/memories/${id}`),
      api('GET', `/memories/${id}/sources`).catch(() => ({ items: [] })),
    ]);

    const field = (k, v) => h('div', { class: 'field' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));

    const nodes = [
      h('div', { class: 'mem-head' }, typeTag(m.type), memoryStatusTag(m.status)),
      h('div', { class: 'field' }, h('div', { class: 'v', style: { fontSize: 'var(--fs-lg)', lineHeight: '1.6' } }, m.content)),

      /**
       * 槽位是记忆参与冲突判定的依据（§13.7）。
       * 显示出来用户才能理解「为什么这两条会打架」。
       */
      m.predicate_key
        ? field(
            '槽位（冲突判定的依据）',
            h(
              'div',
              { class: 'slot-line' },
              `${m.subject_key ?? '?'} · ${m.predicate_key} · ${m.object_value ?? '（无取值）'} · ${m.polarity === 'deny' ? '否定' : '肯定'}`
            )
          )
        : h('div', { class: 'dim', style: { marginBottom: '16px' } }, '这条记忆没有槽位，因此不参与冲突判定。'),

      field(
        '时间',
        h(
          'div',
          {},
          h('div', {}, `${m.valid_from ? formatDate(m.valid_from) : '未记录起点'} 起`),
          m.valid_until ? h('div', { class: 'dim' }, `${formatDate(m.valid_until)} 止`) : null,
          h('div', { class: 'dim' }, `记于 ${formatDateTime(m.created_at)}`)
        )
      ),

      field(
        '评分',
        `重要度 ${(m.importance_score ?? 0).toFixed(2)} · 置信 ${(m.confidence_score ?? 0).toFixed(2)} · ${m.source_count ?? 0} 个来源`
      ),
    ];

    if (m.superseded_by) {
      nodes.push(
        field(
          '状态流转',
          h(
            'div',
            { class: 'lifecycle' },
            h(
              'div',
              { class: 'lifecycle-item' },
              '被一条更新的记忆替代',
              h('div', {}, h('button', { class: 'btn small', onclick: () => showMemoryDrawer(m.superseded_by) }, '看新的那条'))
            )
          )
        )
      );
    }

    const sourceItems = sources.items ?? [];
    nodes.push(
      field(
        `来源（${sourceItems.length}）`,
        sourceItems.length === 0
          ? h('div', { class: 'dim' }, '没有可追溯的来源（可能是手工创建，或来源对话已删除）')
          : h(
              'div',
              {},
              h('div', { class: 'dim', style: { marginBottom: '8px' } }, '它是在这些话里记下来的。点一条可以跳到当时的对话。'),
              ...sourceItems.map((s) => sourceNode(s))
            )
      )
    );

    render(body, ...nodes);
  } catch (err) {
    render(body, errorBox(err, () => showMemoryDrawer(id)));
  }
}

/**
 * 一条来源：会话标题 + 原话引用。
 *
 * 【为什么要显示原话而不是只给会话链接】
 *   记忆详情页最有说服力的一栏是「它凭什么记得」——
 *   回答那个问题必须让人看到**当时的原话**。
 *   只给一个会话 id，用户还得点进去在几十条消息里自己找。
 *
 * ⚠️ 原话是截断的（后端截到 300 字）并且带回了完整长度 ——
 *    截断时要把「还有多少字」说出来，不能假装那是全文。
 */
function sourceNode(s) {
  const deleted = !s.message_content && !s.conversation_id;
  const truncated = s.message_chars !== null && s.message_content !== null && s.message_chars > s.message_content.length;

  return h(
    'div',
    {
      class: 'source',
      ...(s.conversation_id
        ? {
            onclick: () => {
              closeDrawer();
              openConversation(s.conversation_id);
            },
          }
        : {}),
    },
    h(
      'div',
      { class: 's-body' },
      h(
        'div',
        { class: 'dim' },
        s.conversation_title ?? (deleted ? '原始对话已删除' : '（未知对话）'),
        s.message_created_at ? ` · ${formatDateTime(s.message_created_at)}` : '',
        deleted ? ' · 消息已随对话删除' : ''
      ),
      s.message_content
        ? h(
            'div',
            { class: 's-quote' },
            s.message_content,
            ...(truncated
              ? [h('span', { class: 'dim' }, ` …（共 ${s.message_chars} 字，已截断）`)]
              : [])
          )
        : null
    ),
    s.conversation_id ? h('span', { class: 'dim', title: '跳到当时的对话' }, '→') : null
  );
}

/**
 * 冲突裁决。
 *
 * 【为什么这是本轮最重要的功能】
 *   库里 23 条 conflict 记忆此前**完全无法处理** ——
 *   界面看不到，也没有操作入口。它们既不会被召回，
 *   也永远不会自己消失，只是静静堆着。
 *
 * 【裁决的语义】「哪个对」不是真假问题，而是
 * 「哪个更接近现在的实际情况」，因此按钮写「这条更接近现在」。
 */
async function showConflictDrawer(id) {
  const body = openDrawer('待裁决', h('div', {}, h('div', { class: 'skeleton' })));

  try {
    const m = await api('GET', `/memories/${id}`);

    /**
     * 找冲突的另一条：同槽位的另一条 conflict 记忆。
     * 后端有 listConflicts（全量），这里只需要同槽位的那一条。
     */
    const all = await api('GET', '/memories?page_size=100&view=management');
    const rival = (all.items ?? []).find(
      (x) => x.id !== m.id && x.predicate_key && x.predicate_key === m.predicate_key && x.status === 'conflict'
    );

    const side = (mem, isSelf) =>
      h(
        'div',
        { class: 'conflict-side' },
        h('div', { class: 'mem-head' }, typeTag(mem.type), h('span', { class: 'dim' }, isSelf ? '这条' : '另一条')),
        h('div', { style: { lineHeight: '1.6' } }, mem.content),
        mem.valid_from ? h('div', { class: 'dim', style: { marginTop: '6px' } }, `${formatDate(mem.valid_from)} 起`) : null
      );

    const nodes = [
      h('p', { class: 'soft' }, '这两条说的是同一件事（同一个槽位），但取值不一样。选一个更接近现在实际情况的 —— 另一条会被标记为「已否定」，不会消失。'),
      h('div', { class: 'slot-line', style: { marginBottom: '4px' } }, `${m.subject_key ?? '?'} · ${m.predicate_key} · ${m.polarity === 'deny' ? '否定' : '肯定'}`),
      h(
        'div',
        { class: 'conflict-grid' },
        side(m, true),
        rival ? side(rival, false) : h('div', { class: 'conflict-side dim' }, '没有找到与之冲突的另一条 —— 它可能是被单独标记为待裁决的。')
      ),
    ];

    if (rival) {
      nodes.push(
        h(
          'div',
          { style: { marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn primary', onclick: () => resolveConflict(m.id, rival.id, '已采纳这条') }, '这条更接近现在'),
          h('button', { class: 'btn', onclick: () => resolveConflict(rival.id, m.id, '已采纳另一条') }, '另一条更接近现在')
        )
      );
    } else {
      nodes.push(
        h(
          'div',
          { style: { marginTop: '16px', display: 'flex', gap: '8px' } },
          h('button', { class: 'btn primary', onclick: () => resolveConflict(m.id, null, '已采纳这条') }, '采纳这条'),
          h('button', { class: 'btn danger', onclick: () => resolveConflict(null, m.id, '已否定这条') }, '这条不对')
        )
      );
    }

    render(body, ...nodes);
  } catch (err) {
    render(body, errorBox(err, () => showConflictDrawer(id)));
  }
}

/**
 * 裁决：采纳 winner，把 loser 标为已否定。
 *
 * ⚠️ 这里是 restore + reject 两个请求，不是原子的 ——
 *    后端目前没有专门的裁决端点。两步之间失败会留下
 *    「一条已恢复、一条未标记」的中间状态，但那是**可恢复**的
 *    （再裁决一次即可）。原子裁决端点属于后端改动，已记入 docs/16。
 */
async function resolveConflict(winnerId, loserId, message) {
  try {
    if (winnerId) await api('POST', `/memories/${winnerId}/restore`);
    if (loserId) await api('POST', `/memories/${loserId}/reject`);
    toast(message, 'success');
    closeDrawer();
    await loadMemories();
    refreshOverview();
  } catch (err) {
    toast(`裁决失败：${err.message}`, 'error');
  }
}

/** 手工添加记忆 */
function showCreateMemoryDrawer() {
  const content = h('textarea', { class: 'input', rows: '3', placeholder: '你想让它记住什么？' });
  const type = h(
    'select',
    { class: 'input' },
    ...['fact', 'preference', 'relationship', 'state'].map((t) => h('option', { value: t }, MEMORY_TYPE_LABEL[t] ?? t))
  );

  const save = h(
    'button',
    {
      class: 'btn primary small',
      onclick: async () => {
        const text = content.value.trim();
        if (text.length === 0) {
          toast('内容不能为空', 'error');
          return;
        }
        await tryApi('POST', '/memories', { content: text, type: type.value }, '已记住');
        closeDrawer();
        loadMemories();
        refreshOverview();
      },
    },
    '记住'
  );

  openDrawer(
    '添加一条记忆',
    h(
      'div',
      {},
      h('p', { class: 'dim' }, '手工添加的记忆没有对话来源，但它和抽取出来的记忆一样参与召回。'),
      h('label', {}, '内容', content),
      h('label', {}, '类型', type)
    ),
    [save]
  );
  content.focus();
}

// ============================================================
// 时间线
// ============================================================

const timeline = createStore({ months: [], category: '', categories: [], loading: false });

async function loadTimeline() {
  const { category } = timeline.get();
  timeline.set({ loading: true });
  const box = document.getElementById('tl-list');
  if (box) render(box, loadingRows(5));

  try {
    const data = await api('GET', `/timeline?page_size=60${category ? `&category=${category}` : ''}`);
    timeline.set({ months: data.months, loading: false });
    renderTimeline();
  } catch (err) {
    timeline.set({ loading: false });
    if (box) render(box, errorBox(err, loadTimeline));
  }
}

async function loadCategories() {
  try {
    const data = await api('GET', '/timeline/categories');
    const cats = data.items ?? data.categories ?? [];
    timeline.set({ categories: cats });

    const sel = document.getElementById('tl-category');
    if (sel && sel.options.length <= 1) {
      render(
        sel,
        h('option', { value: '' }, '全部分类'),
        ...cats.map((c) => {
          // 后端可能返回字符串或 {category, count} 两种形状
          const key = typeof c === 'string' ? c : (c.category ?? '');
          const count = typeof c === 'string' ? undefined : c.count;
          return h('option', { value: key }, `${EVENT_CATEGORY_LABEL[key] ?? key}${count !== undefined ? `（${count}）` : ''}`);
        })
      );
    }
  } catch {
    /* 分类拉不到不影响看时间线 */
  }
}

function renderTimeline() {
  const box = document.getElementById('tl-list');
  if (!box) return;
  const { months = [], loading } = timeline.get();

  if (loading) {
    render(box, loadingRows(5));
    return;
  }

  if (months.length === 0) {
    render(box, emptyState('时间线还是空的', '聊到具体发生的事时，它会自己记下来。你也可以手动补一条。'));
    return;
  }

  const nodes = [];
  for (const month of months) {
    nodes.push(h('div', { class: 'month-head' }, month.month, h('span', { class: 'dim' }, `${month.total} 件`)));
    for (const e of month.items) nodes.push(eventItem(e));
  }
  render(box, ...nodes);
}

function eventItem(e) {
  return h(
    'div',
    { class: 'tl-item' },
    h('div', { class: 'tl-date' }, formatEventTime(e.event_time, e.event_precision)),
    h('div', { class: 'tl-line' }, h('div', { class: `tl-dot ${e.category ?? ''}` })),
    h(
      'div',
      { class: 'tl-body' },
      h(
        'div',
        { class: 'mem-head' },
        e.category ? tag(EVENT_CATEGORY_LABEL[e.category] ?? e.category, 'accent') : null,
        e.source_type === 'manual' ? tag('手动补录', 'info') : null,
        e.timeline_visible === false ? tag('已隐藏', '') : null
      ),
      h('div', { class: 'tl-title' }, e.title),
      e.description ? h('div', { class: 'tl-desc' }, e.description) : null,
      h(
        'div',
        { class: 'tl-actions' },
        h('button', { class: 'btn small', onclick: () => showEventForm(e) }, '编辑'),
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              const hiding = e.timeline_visible !== false;
              await tryApi('PATCH', `/timeline/${e.id}`, { timeline_visible: !hiding }, hiding ? '已从时间线隐藏' : '已恢复');
              loadTimeline();
            },
          },
          e.timeline_visible === false ? '恢复' : '隐藏'
        ),
        h(
          'button',
          {
            class: 'btn small danger',
            onclick: async () => {
              await tryApi('DELETE', `/timeline/${e.id}`, undefined, '已删除');
              loadTimeline();
            },
          },
          '删除'
        )
      )
    )
  );
}

/** 事件表单（新增与编辑共用） */
function showEventForm(existing) {
  const title = h('input', { class: 'input', value: existing?.title ?? '', maxlength: '200' });
  const desc = h('textarea', { class: 'input', rows: '3', value: existing?.description ?? '' });
  const time = h('input', {
    class: 'input',
    type: 'date',
    value: existing ? formatDate(existing.event_time) : formatDate(new Date().toISOString()),
  });
  const cat = h(
    'select',
    { class: 'input' },
    h('option', { value: '' }, '不分类'),
    ...Object.entries(EVENT_CATEGORY_LABEL).map(([k, v]) =>
      h('option', { value: k, ...(existing?.category === k ? { selected: true } : {}) }, v)
    )
  );

  const save = h(
    'button',
    {
      class: 'btn primary small',
      onclick: async () => {
        const t = title.value.trim();
        if (t.length === 0) {
          toast('标题不能为空', 'error');
          return;
        }
        const payload = { title: t, description: desc.value.trim() || null, event_time: time.value, ...(cat.value ? { category: cat.value } : {}) };
        if (existing) await tryApi('PATCH', `/timeline/${existing.id}`, payload, '已更新');
        else await tryApi('POST', '/timeline', payload, '已记下');
        closeDrawer();
        loadTimeline();
      },
    },
    existing ? '保存' : '记下'
  );

  openDrawer(
    existing ? '编辑事件' : '补记一件事',
    h(
      'div',
      {},
      h('p', { class: 'dim' }, '手动补录的事件来源标记为「手动」，和从对话里抽出来的分开显示。'),
      h('label', {}, '发生了什么', title),
      h('label', {}, '补充说明（可选）', desc),
      h('label', {}, '什么时候', time),
      h('label', {}, '分类', cat)
    ),
    [save]
  );
  title.focus();
}

// ============================================================
// 知识图谱
// ============================================================

const graph = createStore({ data: null, loading: false });

const NODE_COLOR = {
  user: '#d97a45',
  person: '#5c9a6b',
  event: '#6b8caf',
  goal: '#cc9a3f',
  memory_group: '#b9a893',
};

const NODE_RADIUS_BASE = { user: 26, person: 17, goal: 16, event: 13, memory_group: 12 };

async function loadGraph() {
  graph.set({ loading: true });
  const box = document.getElementById('graph-box');
  if (box) render(box, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  try {
    const data = await api('GET', '/graph?max_per_kind=14');
    graph.set({ data, loading: false });
    renderGraph();
  } catch (err) {
    graph.set({ loading: false });
    if (box) render(box, errorBox(err, loadGraph));
  }
}

function renderGraph() {
  const box = document.getElementById('graph-box');
  const data = graph.get().data;
  if (!box || !data) return;

  const { nodes, edges, stats } = data;

  if (nodes.length <= 1) {
    render(
      box,
      emptyState('图谱上还没有东西', '它由你聊到的人、经历过的事、设过的目标组成。目前这几类都还没有数据。')
    );
    return;
  }

  const canvas = h('canvas');
  const tip = h('div', { class: 'graph-tip' });

  const legendRows = Object.entries({ user: '你', person: '人', event: '事件', goal: '目标', memory_group: '相关记忆' })
    .filter(([kind]) => nodes.some((n) => n.kind === kind))
    .map(([kind, label]) =>
      h('div', { class: 'row' }, h('span', { class: 'legend-dot', style: { background: NODE_COLOR[kind] } }), label)
    );

  const wrap = h(
    'div',
    { class: 'graph-wrap' },
    canvas,
    tip,
    h('div', { class: 'graph-legend' }, ...legendRows),
    h('div', { class: 'graph-hint' }, `${stats.people} 人 · ${stats.events} 件事 · ${stats.goals} 个目标 · ${stats.memories} 条记忆`)
  );

  render(box, wrap);

  // ---------- 力导向布局 ----------
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;

  const sim = nodes.map((n, i) => {
    // 用户固定在中心；其余按角度均分初始位置
    const angle = (i / Math.max(1, nodes.length - 1)) * Math.PI * 2;
    const ring = n.kind === 'user' ? 0 : n.kind === 'memory_group' ? 210 : 130;
    return {
      ...n,
      x: Math.cos(angle) * ring,
      y: Math.sin(angle) * ring,
      vx: 0,
      vy: 0,
      r: (NODE_RADIUS_BASE[n.kind] ?? 12) * (0.75 + n.weight * 0.5),
      fixed: n.kind === 'user',
    };
  });

  const byId = new Map(sim.map((n) => [n.id, n]));
  const links = edges.map((e) => ({ source: byId.get(e.source), target: byId.get(e.target), kind: e.kind })).filter((l) => l.source && l.target);

  function resize() {
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 一步物理模拟。
   *
   * 【为什么自己写而不引 d3-force】需要的规则只有三条
   * （斥力、弹簧、向心），约 40 行；引 d3 是 +90KB 依赖，
   * 而本项目的原则是零构建、零依赖。收益与代价不成比例。
   */
  function tick(alpha) {
    for (let i = 0; i < sim.length; i++) {
      const a = sim[i];
      if (a.fixed) continue;
      for (let j = i + 1; j < sim.length; j++) {
        const b = sim[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // 完全重合时给随机微扰，否则会永远粘在一起
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const rep = (1400 * alpha) / d2;
        const fx = (dx / d) * rep;
        const fy = (dy / d) * rep;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const l of links) {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      // 记忆分组挂得远一点，让「人 → 记忆」形成可见的层次
      const rest = l.kind === 'knows_about' ? 96 : 132;
      const f = (d - rest) * 0.012 * alpha;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!l.source.fixed) {
        l.source.vx += fx;
        l.source.vy += fy;
      }
      if (!l.target.fixed) {
        l.target.vx -= fx;
        l.target.vy -= fy;
      }
    }

    for (const n of sim) {
      if (n.fixed) continue;
      // 向心力：把整体收在画布中央附近
      n.vx -= n.x * 0.006 * alpha;
      n.vy -= n.y * 0.006 * alpha;
      n.vx *= 0.86;
      n.vy *= 0.86;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    const cx = width / 2;
    const cy = height / 2;

    ctx.lineWidth = 1;
    for (const l of links) {
      ctx.strokeStyle = l.kind === 'knows_about' ? 'rgba(185,168,147,0.45)' : 'rgba(217,207,192,0.85)';
      ctx.beginPath();
      ctx.moveTo(cx + l.source.x, cy + l.source.y);
      ctx.lineTo(cx + l.target.x, cy + l.target.y);
      ctx.stroke();
    }

    for (const n of sim) {
      const x = cx + n.x;
      const y = cy + n.y;
      const color = NODE_COLOR[n.kind] ?? '#999';

      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.kind === 'memory_group' ? 'rgba(185,168,147,0.2)' : color;
      ctx.fill();
      if (n.kind === 'memory_group') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // 只给用户节点与权重高的常显标签；全画出来会糊成一团
      if (n.kind === 'user' || n.weight > 0.62) {
        ctx.font = n.kind === 'user' ? '600 13px system-ui' : '12px system-ui';
        ctx.fillStyle = '#2f2a24';
        ctx.textAlign = 'center';
        const label = n.label.length > 12 ? `${n.label.slice(0, 12)}…` : n.label;
        ctx.fillText(label, x, y - n.r - 6);
      }
    }
  }

  let alpha = 1;
  let raf = 0;

  function loop() {
    tick(alpha);
    alpha = Math.max(0.08, alpha * 0.985);
    draw();
    raf = requestAnimationFrame(loop);
  }

  resize();
  const ro = new ResizeObserver(() => {
    resize();
    draw();
  });
  ro.observe(wrap);
  loop();

  // ---------- 交互 ----------
  let dragging = null;
  let dragMoved = false;

  function hitTest(mx, my) {
    const cx = width / 2;
    const cy = height / 2;
    for (let i = sim.length - 1; i >= 0; i--) {
      const n = sim[i];
      if (Math.hypot(mx - (cx + n.x), my - (cy + n.y)) <= n.r + 4) return n;
    }
    return null;
  }

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (dragging) {
      dragging.x = mx - width / 2;
      dragging.y = my - height / 2;
      dragging.vx = 0;
      dragging.vy = 0;
      dragMoved = true;
      alpha = Math.max(alpha, 0.35);
      return;
    }

    const node = hitTest(mx, my);
    if (node) {
      tip.style.display = 'block';
      tip.style.left = `${mx + 12}px`;
      tip.style.top = `${my + 12}px`;
      tip.textContent = `${node.label}${node.count !== undefined ? `（${node.count}）` : ''}${node.detail ? ` · ${node.detail}` : ''}`;
      canvas.style.cursor = 'pointer';
    } else {
      tip.style.display = 'none';
      canvas.style.cursor = 'grab';
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const node = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (node && !node.fixed) {
      dragging = node;
      dragMoved = false;
    }
  });

  canvas.addEventListener('mouseup', () => {
    dragging = null;
  });

  canvas.addEventListener('mouseleave', () => {
    dragging = null;
    tip.style.display = 'none';
  });

  /** 点节点跳到对应页面 —— 图谱的价值在于「从图找到东西」 */
  canvas.addEventListener('click', (e) => {
    if (dragMoved) return;
    const rect = canvas.getBoundingClientRect();
    const node = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!node) return;

    if (node.kind === 'person') navigate('relations');
    else if (node.kind === 'event') navigate('timeline');
    else if (node.kind === 'goal') navigate('goals');
    else if (node.kind === 'memory_group') {
      const name = node.label.replace(/ · 相关记忆$/, '');
      memories.set({ view: 'management', q: name });
      const searchInput = document.getElementById('mem-search');
      if (searchInput) searchInput.value = name;
      navigate('memories');
      setTimeout(() => loadMemories(), 0);
    }
  });

  /** 切走时停掉动画，否则后台一直在跑 requestAnimationFrame */
  window.addEventListener(
    'hashchange',
    () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
    { once: true }
  );
}

// ============================================================
// 人际关系
// ============================================================

const relations = createStore({ items: [], loading: false, q: '' });

async function loadRelations() {
  relations.set({ loading: true });
  const box = document.getElementById('rel-list');
  if (box) render(box, loadingRows(3));
  try {
    const { q } = relations.get();
    const data = await api('GET', `/relationships?page_size=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    relations.set({ items: data.items, loading: false });
    renderRelations();
  } catch (err) {
    relations.set({ loading: false });
    if (box) render(box, errorBox(err, loadRelations));
  }
}

function renderRelations() {
  const box = document.getElementById('rel-list');
  if (!box) return;
  const { items = [], loading } = relations.get();

  if (loading) {
    render(box, loadingRows(3));
    return;
  }

  if (items.length === 0) {
    render(
      box,
      emptyState('还没有记下任何人', '你在对话里提到的人会被自动记住，也会出现在知识图谱上。这里可以补充关系类型和说明。')
    );
    return;
  }

  render(
    box,
    ...items.map((r) =>
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'mem-head' },
          h('span', { style: { fontWeight: '580', fontSize: 'var(--fs-lg)' } }, r.name),
          r.relation_type ? tag(RELATION_TYPE_LABEL[r.relation_type] ?? r.relation_type, 'accent') : null,
          r.status === 'ended' ? tag('已结束', '') : null,
          r.status === 'archived' ? tag('已归档', '') : null
        ),
        r.description ? h('div', { class: 'tl-desc' }, r.description) : h('div', { class: 'dim' }, '还没有补充说明'),
        h(
          'div',
          { class: 'mem-foot' },
          h('span', {}, `更新于 ${formatRelative(r.updated_at)}`),
          h(
            'div',
            { class: 'mem-actions' },
            h('button', { class: 'btn small', onclick: () => showRelationForm(r) }, '编辑'),
            h(
              'button',
              {
                class: 'btn small danger',
                onclick: async () => {
                  await tryApi('DELETE', `/relationships/${r.id}`, undefined, '已删除');
                  loadRelations();
                },
              },
              '删除'
            )
          )
        )
      )
    )
  );
}

function showRelationForm(existing) {
  const name = h('input', { class: 'input', value: existing?.name ?? '', maxlength: '100' });
  const type = h(
    'select',
    { class: 'input' },
    h('option', { value: '' }, '不填'),
    ...Object.entries(RELATION_TYPE_LABEL).map(([k, v]) =>
      h('option', { value: k, ...(existing?.relation_type === k ? { selected: true } : {}) }, v)
    )
  );
  const desc = h('textarea', { class: 'input', rows: '3', value: existing?.description ?? '' });

  const save = h(
    'button',
    {
      class: 'btn primary small',
      onclick: async () => {
        const n = name.value.trim();
        if (n.length === 0) {
          toast('名字不能为空', 'error');
          return;
        }
        const payload = { name: n, relation_type: type.value || null, description: desc.value.trim() || null };
        if (existing) await tryApi('PATCH', `/relationships/${existing.id}`, payload, '已保存');
        else await tryApi('POST', '/relationships', payload, '已记下');
        closeDrawer();
        loadRelations();
      },
    },
    existing ? '保存' : '添加'
  );

  openDrawer(
    existing ? '编辑关系' : '记下一个人',
    h(
      'div',
      {},
      h('p', { class: 'dim' }, '这里记的是「这个人是谁、和你什么关系」。你在对话里提到的事会自动关联到这个人名下。'),
      h('label', {}, '怎么称呼', name),
      h('label', {}, '关系', type),
      h('label', {}, '说明（可选）', desc)
    ),
    [save]
  );
  name.focus();
}

// ============================================================
// 目标
// ============================================================

const goals = createStore({ items: [], loading: false });

async function loadGoals() {
  goals.set({ loading: true });
  const box = document.getElementById('goal-list');
  if (box) render(box, loadingRows(3));
  try {
    const data = await api('GET', '/goals?page_size=50');
    goals.set({ items: data.items, loading: false });
    renderGoals();
  } catch (err) {
    goals.set({ loading: false });
    if (box) render(box, errorBox(err, loadGoals));
  }
}

function renderGoals() {
  const box = document.getElementById('goal-list');
  if (!box) return;
  const { items = [], loading } = goals.get();

  if (loading) {
    render(box, loadingRows(3));
    return;
  }

  if (items.length === 0) {
    render(box, emptyState('还没有设过目标', '目标会和你的记忆连起来 —— 它记得你在往哪儿走。'));
    return;
  }

  render(
    box,
    ...items.map((g) =>
      h(
        'div',
        { class: `goal-item ${g.status}` },
        h(
          'div',
          { class: 'mem-head' },
          tag(GOAL_STATUS_LABEL[g.status] ?? g.status, g.status === 'active' ? 'accent' : g.status === 'completed' ? 'ok' : ''),
          h('span', { class: 'dim' }, `重要度 ${(g.priority ?? 0.5).toFixed(2)}`)
        ),
        h('div', { class: 'goal-title' }, g.title),
        g.description ? h('div', { class: 'goal-desc' }, g.description) : null,
        h(
          'div',
          { class: 'mem-foot' },
          g.started_at ? h('span', {}, `${formatDate(g.started_at)} 开始`) : null,
          g.target_at ? h('span', {}, `目标 ${formatDate(g.target_at)}`) : null,
          g.completed_at ? h('span', {}, `${formatDate(g.completed_at)} 完成`) : null
        ),
        progressBar(g),
        h(
          'div',
          { class: 'mem-actions', style: { marginTop: '10px' } },
          g.status === 'active' ? h('button', { class: 'btn small', onclick: () => patchGoal(g, { status: 'paused' }, '已搁置') }, '搁置') : null,
          g.status === 'paused' ? h('button', { class: 'btn small', onclick: () => patchGoal(g, { status: 'active' }, '已恢复') }, '继续') : null,
          g.status !== 'completed' && g.status !== 'archived'
            ? h('button', { class: 'btn small primary', onclick: () => patchGoal(g, { status: 'completed' }, '完成了') }, '完成')
            : null,
          h('button', { class: 'btn small', onclick: () => showGoalForm(g) }, '编辑'),
          h(
            'button',
            {
              class: 'btn small danger',
              onclick: async () => {
                await tryApi('DELETE', `/goals/${g.id}`, undefined, '已删除');
                loadGoals();
              },
            },
            '删除'
          )
        )
      )
    )
  );
}

/**
 * 进度条：只有同时有起止时间才画。
 * 没有起点时画一条 0% 的进度条等于编造信息。
 */
function progressBar(g) {
  if (!g.started_at || !g.target_at) return null;
  const start = new Date(g.started_at).getTime();
  const end = new Date(g.target_at).getTime();
  if (!(end > start)) return null;
  const pct = Math.max(0, Math.min(100, ((Date.now() - start) / (end - start)) * 100));
  return h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } }));
}

async function patchGoal(g, patch, message) {
  await tryApi('PATCH', `/goals/${g.id}`, patch, message);
  loadGoals();
}

function showGoalForm(existing) {
  const title = h('input', { class: 'input', value: existing?.title ?? '', maxlength: '200' });
  const desc = h('textarea', { class: 'input', rows: '3', value: existing?.description ?? '' });
  const priority = h('input', { class: 'input', type: 'range', min: '0', max: '1', step: '0.05', value: String(existing?.priority ?? 0.5) });
  const started = h('input', {
    class: 'input',
    type: 'date',
    value: existing?.started_at ? formatDate(existing.started_at) : formatDate(new Date().toISOString()),
  });
  const target = h('input', { class: 'input', type: 'date', value: existing?.target_at ? formatDate(existing.target_at) : '' });

  const save = h(
    'button',
    {
      class: 'btn primary small',
      onclick: async () => {
        const t = title.value.trim();
        if (t.length === 0) {
          toast('目标名称不能为空', 'error');
          return;
        }
        const payload = {
          title: t,
          description: desc.value.trim() || null,
          priority: Number(priority.value),
          started_at: started.value || null,
          target_at: target.value || null,
        };
        if (existing) await tryApi('PATCH', `/goals/${existing.id}`, payload, '已保存');
        else await tryApi('POST', '/goals', payload, '已创建');
        closeDrawer();
        loadGoals();
        refreshOverview();
      },
    },
    existing ? '保存' : '创建'
  );

  openDrawer(
    existing ? '编辑目标' : '新增目标',
    h(
      'div',
      {},
      h('label', {}, '目标', title),
      h('label', {}, '说明（可选）', desc),
      h('label', {}, '重要度', priority),
      h('label', {}, '开始时间', started),
      h('label', {}, '目标时间（可选）', target)
    ),
    [save]
  );
  title.focus();
}

// ============================================================
// 回顾
// ============================================================

const review = createStore({ kind: 'week', from: '', to: '', output: '', loading: false });

async function runReview() {
  const { kind, from, to } = review.get();
  review.set({ loading: true, output: '' });
  renderReview();

  try {
    const payload = kind === 'custom' ? { kind, from, to } : { kind };
    const data = await api('POST', '/life-review', payload);
    review.set({ output: data.review ?? data.content ?? '', loading: false });
    renderReview();
  } catch (err) {
    review.set({ loading: false });
    render(document.getElementById('review-out'), errorBox(err));
  }
}

function renderReview() {
  const box = document.getElementById('review-out');
  if (!box) return;
  const { output, loading } = review.get();

  if (loading) {
    render(box, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', {}, '正在回顾…')));
    return;
  }

  if (!output) {
    render(box, emptyState('选一个时间段，让它回顾一下', '它会把你那段时间里的事、说过的话串成一个连贯的说法。'));
    return;
  }

  const body = h('div', { class: 'review-body' });
  // 与消息正文同一口径：先过 renderMarkdown（它先转义再加标签）
  body.innerHTML = renderMarkdown(output);
  render(box, body);
}

// ============================================================
// 设置
// ============================================================

const settings = createStore({ data: null, loading: false });

async function loadSettings() {
  settings.set({ loading: true });
  try {
    const data = await api('GET', '/settings');
    settings.set({ data, loading: false });
    renderSettings();
  } catch (err) {
    settings.set({ loading: false });
    render(document.getElementById('settings-out'), errorBox(err, loadSettings));
  }
}

function settingRow(label, hint, control) {
  return h(
    'div',
    { class: 'setting' },
    h('div', { class: 's-label' }, h('div', { class: 't' }, label), hint ? h('div', { class: 'd' }, hint) : null),
    h('div', { class: 's-control' }, control)
  );
}

function segmented(options, current, onPick) {
  return h(
    'div',
    { class: 'segmented' },
    ...options.map((o) => h('button', { class: o.value === current ? 'on' : '', onclick: () => onPick(o.value) }, o.label))
  );
}

function renderSettings() {
  const box = document.getElementById('settings-out');
  const data = settings.get().data;
  if (!box || !data) return;

  const prefs = data.preferences ?? {};
  const patch = (body, message) => tryApi('PATCH', '/settings', body, message).then(loadSettings);

  const autoExtract = h('input', {
    type: 'checkbox',
    ...(data.memory.auto_extract ? { checked: true } : {}),
    onchange: (e) => patch({ memory: { auto_extract: e.target.checked } }, e.target.checked ? '已开启自动整理' : '已关闭自动整理'),
  });

  const tz = h('input', { class: 'input', value: data.timezone, style: { maxWidth: '220px' } });
  const tzSave = h(
    'button',
    {
      class: 'btn small',
      onclick: () => {
        const v = tz.value.trim();
        if (!v) {
          toast('时区不能为空', 'error');
          return;
        }
        patch({ timezone: v }, '时区已改');
      },
    },
    '保存'
  );

  const name = h('input', { class: 'input', value: prefs.display_name ?? '', placeholder: '它该怎么称呼你', style: { maxWidth: '220px' } });
  const nameSave = h('button', { class: 'btn small', onclick: () => patch({ display_name: name.value.trim() }, '已保存') }, '保存');

  render(
    box,
    h(
      'div',
      { class: 'card' },
      settingRow(
        '自动整理记忆',
        '关掉之后后台不再从对话里抽取记忆。已经记住的仍然有效。',
        h('label', { class: 'switch' }, autoExtract, h('span', { class: 'track' }))
      ),

      /**
       * 回答风格与长度此前**只能进数据库改** ——
       * 而它们直接改变回答的样子，是「像朋友」最直接的旋钮。
       * 空值表示「没选过」，与选了默认值是两件事，因此有「默认」这一档。
       */
      settingRow(
        '说话方式',
        '「直接」说得更直白，「温和」更照顾情绪，「详细」会展开讲。',
        segmented(
          [
            { value: '', label: '默认' },
            { value: 'direct', label: '直接' },
            { value: 'gentle', label: '温和' },
            { value: 'detailed', label: '详细' },
          ],
          prefs.response_style ?? '',
          (v) => patch({ response_style: v || null }, '已保存')
        )
      ),

      settingRow(
        '回答长度',
        '短回答更利落，长回答更有铺垫。',
        segmented(
          [
            { value: '', label: '默认' },
            { value: 'short', label: '短' },
            { value: 'medium', label: '中' },
            { value: 'long', label: '长' },
          ],
          prefs.response_length ?? '',
          (v) => patch({ response_length: v || null }, '已保存')
        )
      ),

      settingRow('怎么称呼你', '留空则它不主动叫你的名字。', h('div', { style: { display: 'flex', gap: '8px' } }, name, nameSave)),

      settingRow('时区', '影响「今天」「昨天」的判断与日期显示。', h('div', { style: { display: 'flex', gap: '8px' } }, tz, tzSave))
    ),

    h(
      'div',
      { class: 'card', style: { marginTop: '10px' } },
      h('div', { class: 'dim', style: { marginBottom: '10px' } }, '当前使用的模型'),
      settingRow('模型', '由服务端配置决定，界面上不能改。', `${data.model.provider} · ${data.model.model}`)
    )
  );
}

// ============================================================
// 视图切换
// ============================================================

const VIEW_LOADERS = {
  chat: () => renderChatView(),
  memories: () => loadMemories(),
  timeline: () => {
    loadCategories();
    loadTimeline();
  },
  graph: () => loadGraph(),
  relations: () => loadRelations(),
  goals: () => loadGoals(),
  review: () => renderReview(),
  settings: () => loadSettings(),
};

const VIEW_TITLES = {
  chat: '对话',
  memories: '记忆',
  timeline: '时间线',
  graph: '知识图谱',
  relations: '人际关系',
  goals: '目标',
  review: '回顾',
  settings: '设置',
};

let currentView = null;

function showView(name) {
  const view = VIEW_TITLES[name] ? name : 'chat';
  shell.set({ route: view });

  for (const el of document.querySelectorAll('.view')) el.classList.toggle('active', el.id === `view-${view}`);
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === view);

  /**
   * ⚠️ 只在**真的换了视图**时重新加载。
   *    hashchange 在同视图内也会发生（#/chat/a → #/chat/b），
   *    那时重载会让列表闪一下、也丢掉滚动位置。
   */
  const changed = currentView !== view;
  currentView = view;
  if (changed) {
    closeDrawer();
    VIEW_LOADERS[view]?.();
  }
}

// ============================================================
// 导航与状态
// ============================================================

function renderNavBadge() {
  const { overview } = shell.get();
  const nav = document.querySelector('[data-nav="memories"]');
  if (!nav) return;

  const old = nav.querySelector('.badge');
  if (old) old.remove();

  // 只有真的有待处理事项时才显示 —— 常驻一个 0 是噪声
  if (overview && overview.conflict > 0) {
    nav.appendChild(h('span', { class: 'badge', title: `${overview.conflict} 条待裁决` }, String(overview.conflict)));
  }
}

function renderHealth() {
  const el = document.getElementById('health');
  if (!el) return;
  const { health } = shell.get();
  el.className = `health ${health === 'ok' ? 'ok' : health === 'bad' ? 'bad' : ''}`;
  el.textContent = health === 'ok' ? '已连接' : health === 'bad' ? '连不上服务' : '检查中…';
}

// ============================================================
// 启动
// ============================================================

function bindChrome() {
  document.getElementById('btn-new-chat').onclick = newChat;
  document.getElementById('btn-create-memory').onclick = showCreateMemoryDrawer;
  document.getElementById('btn-new-event').onclick = () => showEventForm(null);
  document.getElementById('btn-new-relation').onclick = () => showRelationForm(null);
  document.getElementById('btn-new-goal').onclick = () => showGoalForm(null);

  const search = document.getElementById('mem-search');
  search.oninput = debounce(() => {
    memories.set({ q: search.value });
    loadMemories();
  }, 320);

  document.getElementById('mem-view').onchange = (e) => {
    memories.set({ view: e.target.value, q: '' });
    search.value = '';
    loadMemories();
  };

  document.getElementById('tl-category').onchange = (e) => {
    timeline.set({ category: e.target.value });
    loadTimeline();
  };

  const relSearch = document.getElementById('rel-search');
  relSearch.oninput = debounce(() => {
    relations.set({ q: relSearch.value });
    loadRelations();
  }, 320);

  document.getElementById('review-kind').onchange = (e) => {
    const kind = e.target.value;
    review.set({ kind });
    document.getElementById('review-custom').classList.toggle('hidden', kind !== 'custom');
  };
  // 自定义区间：两个日期要实时进 state，否则点「生成回顾」时读到的是空串
  document.getElementById('review-from').onchange = (e) => review.set({ from: e.target.value });
  document.getElementById('review-to').onchange = (e) => review.set({ to: e.target.value });
  document.getElementById('btn-review').onclick = runReview;

  const input = document.getElementById('input');
  const composer = document.getElementById('composer');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(200, input.scrollHeight)}px`;
  });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || chat.get().streaming) return;
    input.value = '';
    input.style.height = 'auto';
    sendMessage(text);
  });

  shell.subscribe(() => {
    renderNavBadge();
    renderHealth();
  });
  renderHealth();
}

function boot() {
  bindChrome();

  onRouteChange((route) => {
    showView(route.name);
    // #/chat/<id> 直接打开某个会话
    if (route.name === 'chat' && route.params[0] && route.params[0] !== chat.get().activeId) {
      openConversation(route.params[0], { silent: true });
    }
    if (route.name === 'memories' && route.params[0]) showMemoryDrawer(route.params[0]);
  });

  checkHealth();
  setInterval(checkHealth, 30_000);
  refreshOverview();
  loadConversations()
    .then(renderConversations)
    .catch(() => {});
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

// 测试入口（app.dom.test.ts 用）
export {
  chat,
  memories,
  timeline,
  graph,
  relations,
  goals,
  review,
  settings,
  shell,
  api,
  openConversation,
  newChat,
  showView,
  renderMessages,
  renderConversations,
  renderMemories,
  renderRelations,
  renderGoals,
  renderTimeline,
  renderNavBadge,
  messageNode,
  memoryItem,
  eventItem,
  overviewRow,
  tracePanel,
  daySeparator,
  progressBar,
  sourceNode,
  NODE_COLOR,
  MEMORY_TYPE_LABEL,
  MEMORY_STATUS_META,
  EVENT_CATEGORY_LABEL,
  GOAL_STATUS_LABEL,
};
