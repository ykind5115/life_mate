/**
 * LifeMate 前端
 *
 * 【设计取舍】
 *   原生 ESM + 手写 DOM，无框架、无构建步骤。
 *   docs/02 §6 规定的是 Next.js + React + Tailwind —— 那是 Phase 7 的目标形态。
 *   本文件的定位是「现在就能用的最小可用界面」：
 *   页面只有 5 个、状态很少，引入构建链的收益要到页面复杂起来才体现。
 *   将来换 Next.js 时整体替换这一层，API 与后端不用动。
 *
 * 【安全：所有插值都必须转义】
 *   页面渲染的是**模型输出**与**用户自己的记忆内容**。
 *   因此一律走 textContent；唯一的例外是 renderMarkdown ——
 *   它先整体转义再按白名单加标签，见 markdown.js 的说明。
 */

import { renderMarkdown } from './markdown.js';

const API = '/api/v1';

// ============================================================
// 工具
// ============================================================

const $ = (sel) => document.querySelector(sel);

/** 建元素。attrs 里的 text 走 textContent，避免 HTML 注入 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // 只在 renderMarkdown 内部用
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(c);
  }
  return node;
}

/** 统一的 API 调用。失败时抛出带后端错误码的异常 */
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
  }

  if (!res.ok || parsed.success === false) {
    const err = parsed.error ?? {};
    const detail = Array.isArray(err.details)
      ? '：' + err.details.map((d) => d.message).join('；')
      : '';
    throw new Error(`${err.message ?? '请求失败'}${detail}`);
  }

  return parsed.data;
}

/** 相对时间。用于会话与记忆的时间戳 */
function relTime(iso) {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

// ============================================================
// 时间显示（docs/12 §方案 1）
// ============================================================

/**
 * 消息上的绝对时间，如「09-24 08:51」。
 *
 * ⚠️ 用 getMonth/getDate 这类**本地时间**取值，不要 toISOString().slice()。
 *    toISOString 转的是 UTC：本机 UTC+8，凌晨 0-8 点发的消息
 *    会被显示成前一天 —— 用户看到「昨天 17:30」而实际是「今天 01:30」。
 *    实测过同类问题（时间注入那边也必须用 users.timezone，理由相同）。
 */
function absTime(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 同一天（按本地时间） */
function sameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 日期分隔条上的文字：「今天」「昨天」「09-22 周二」。
 *
 * 为什么要有分隔条，而不只是在每条消息上标时间：
 *   用户反馈 5 的原话是「我隔了两天再跟他讲话，她根本就分不清中间过了多长时间」——
 *   他自己看聊天记录时也有同样的问题。逐条标时间不够醒目，
 *   一个横贯的分隔条才能一眼看出「这里断开了一天」。
 */
function dayLabel(d) {
  const now = new Date();
  if (sameLocalDay(d, now)) return '今天';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return '昨天';

  const p2 = (n) => String(n).padStart(2, '0');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const ymd = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  // 跨年才写年份：绝大多数的聊天记录都在同一年内
  return d.getFullYear() === now.getFullYear() ? `${ymd} ${week}` : `${d.getFullYear()}-${ymd}`;
}

// ============================================================
// 路由
// ============================================================

const VIEWS = ['chat', 'memories', 'timeline', 'goals', 'review', 'settings'];

function currentView() {
  const hash = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(hash) ? hash : 'chat';
}

function showView(name) {
  for (const v of VIEWS) {
    $(`#view-${v}`).classList.toggle('active', v === name);
  }
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });

  // 进入视图时按需加载数据
  if (name === 'memories') loadMemories();
  if (name === 'timeline') loadTimeline();
  if (name === 'goals') loadGoals();
  if (name === 'settings') loadSettings();
}

window.addEventListener('hashchange', () => showView(currentView()));

// ============================================================
// 健康检查
// ============================================================

async function checkHealth() {
  const box = $('#health');
  try {
    const res = await fetch('/health', { signal: AbortSignal.timeout(4000) });
    box.textContent = res.ok ? '服务正常' : `异常 (${res.status})`;
    box.className = `health ${res.ok ? 'ok' : 'bad'}`;
  } catch {
    box.textContent = '连不上服务';
    box.className = 'health bad';
  }
}

// ============================================================
// 对话
// ============================================================

let conversationId = null;
let streaming = false;

/**
 * 加载历史会话列表。
 *
 * ⚠️ 每次发完消息、切换会话都要重新加载 —— 因为 updated_at 变了，
 *    顺序会变（最近聊的排最前）。不刷新的话列表顺序会「卡住」，
 *    用户找不到刚聊过的那个。
 */
async function loadConversations() {
  const box = $('#conversations');
  try {
    const data = await api('GET', '/conversations?page_size=50');
    const items = data.items ?? [];

    if (items.length === 0) {
      box.replaceChildren(el('div', { class: 'dim', style: 'padding:8px 10px', text: '还没有会话' }));
      return;
    }

    box.replaceChildren(
      ...items.map((c) => {
        const node = el('div', {
          class: `conv-item ${c.id === conversationId ? 'current' : ''}`,
          onclick: () => openConversation(c.id),
        }, [
          // 标题为空时给个占位 —— 空条目看起来像 bug
          el('div', { class: 'conv-title', text: c.title || '（未命名会话）' }),
          el('div', { class: 'conv-meta', text: relTime(c.updated_at) }),
        ]);

        // 删除按钮：hover 才显眼，但一直存在（触屏没有 hover）
        const del = el('button', {
          class: 'btn small danger',
          text: '×',
          title: '删除这个会话',
          style: 'float:right;margin-top:-20px;padding:1px 7px;opacity:.55',
          onclick: async (ev) => {
            // 阻止冒泡，否则会同时触发「打开会话」
            ev.stopPropagation();
            if (!confirm('删除这个会话？\n\n消息会被彻底删除，但已整理出的长期记忆会保留。')) return;
            try {
              await api('DELETE', `/conversations/${c.id}`);
              // 删掉的正是当前打开的 → 回到新会话状态
              if (c.id === conversationId) startNewChat();
              loadConversations();
            } catch (err) {
              alert(`删除失败：${err.message}`);
            }
          },
        });
        node.appendChild(del);
        return node;
      })
    );
  } catch (err) {
    box.replaceChildren(el('div', { class: 'dim', style: 'padding:8px 10px', text: `加载失败：${err.message}` }));
  }
}

/**
 * 打开一个历史会话：把消息读回来渲染，并把它设为当前会话。
 *
 * 打开之后可以**继续在这个会话里聊** —— 后端会把新消息追加进去，
 * 而且模型能看到该会话之前的历史（最近 20 条原文）。
 *
 * ⚠️ 用 /conversations/:id 而不是 /conversations/:id/messages：
 *    前者返回 title 与 status，后者只有消息数组。
 *    分页接口更适合「加载更多」，而打开一个会话需要标题。
 */
async function openConversation(id) {
  const box = $('#messages');
  box.replaceChildren(el('div', { class: 'dim', text: '加载中…' }));

  try {
    const data = await api('GET', `/conversations/${id}`);
    const items = data.messages ?? [];

    conversationId = id;
    $('#chat-title').textContent = data.title || '对话';

    if (items.length === 0) {
      // 已删除的会话其消息是物理删除的（C29），因此这里为空是正常状态
      box.replaceChildren(
        el('div', { class: 'empty' }, [
          el('p', { text: data.status === 'deleted' ? '这个会话已被删除。' : '这个会话还没有消息。' }),
          ...(data.status === 'deleted'
            ? [el('p', { class: 'dim', text: '消息已彻底删除，但从中整理出的长期记忆按删除规则保留。' })]
            : []),
        ])
      );
    } else {
      box.replaceChildren();
      /**
       * 重置日期分隔状态：否则上一个会话最后一次渲染的日期
       * 会压制这个会话第一条消息的分隔条。
       * 用 epoch 而不是 null —— 「与任何真实日期都不同天」天然成立。
       */
      lastRenderedDay = new Date(0);
      for (const m of items) {
        // 只渲染 user / assistant；system 与 tool 是 Agent 内部协议，不该给用户看
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        /**
         * created_at 由 DTO 提供（conversations.ts 的 toMessageDto）。
         * 历史消息自带时间，因此这里能直接把时间与分隔条一起渲染出来。
         */
        addMessage(m.role, m.content, {
          skipScroll: true,
          ...(m.created_at ? { createdAt: m.created_at } : {}),
        });
      }
    }

    scrollToBottom();
    loadConversations(); // 刷新高亮
  } catch (err) {
    box.replaceChildren(el('div', { class: 'dim', text: `加载失败：${err.message}` }));
  }
}

/** 回到「新会话」状态。不删数据，只是把当前指针清掉 */
function startNewChat() {
  conversationId = null;
  $('#chat-title').textContent = '对话';
  // 与 openConversation 同理：不清的话上一个会话的日期会压制新会话的分隔条
  lastRenderedDay = new Date(0);
  $('#messages').replaceChildren(
    el('div', { class: 'empty' }, [
      el('p', { text: '新会话。' }),
      el('p', { class: 'dim', text: '记忆是跨会话共享的 —— 换个会话它也记得你。' }),
    ])
  );
  loadConversations();
  $('#input').focus();
}

function addMessage(role, text, opts = {}) {
  const wrap = el('div', { class: `msg ${role === 'user' ? 'me' : ''}` }, [
    el('div', { class: 'msg-role', text: role === 'user' ? '你' : 'LifeMate' }),
    el('div', { class: 'msg-body' }),
    el('div', { class: 'msg-meta' }),
  ]);

  const body = wrap.querySelector('.msg-body');
  if (role === 'user') body.textContent = text;
  else body.innerHTML = renderMarkdown(text);

  // 清掉开场提示
  const empty = $('#messages .empty');
  if (empty) empty.remove();

  /**
   * ⚠️ 顺序不可颠倒：必须**先**把 wrap 挂进 DOM，**再**调 stampMessage。
   *
   * stampMessage 内部会 `box.insertBefore(divider, wrap)`，
   * 而 insertBefore 的参照节点**必须已经是 box 的子节点**。
   *
   * 🔴 2026-09-26 实测就是这个顺序写反了：打开任意一个历史会话，
   *    第一条消息就出错，界面只显示「加载失败：…」，整个列表渲染不出来。
   *    当时 399 个 Node 测试全绿 —— 因为测试跑不到浏览器 DOM。
   *    现在由 public/app.dom.test.ts 守住，且它断言的是
   *    「分隔条真的插进去了」而不只是「没抛错」：
   *    stampMessage 里的防御性 return 会把顺序错误变成**静默不插分隔条**，
   *    只断言「不抛错」的测试在故意写坏顺序后依然全绿（实测过）。
   */
  $('#messages').appendChild(wrap);

  /**
   * 时间显示（docs/12 §方案 1，对应反馈 5）。
   *
   * createdAt 缺失时不显示，而不是显示「现在」——
   * 把不知道的时间编造成此刻，比不显示更糟。
   * stampMessage 内部会按需插入日期分隔条（在 wrap **之前**）。
   */
  if (opts.createdAt) stampMessage(wrap, opts.createdAt);

  if (!opts.skipScroll) scrollToBottom();
  return wrap;
}

/** 上一条已渲染消息的日期。用于判断是否需要插日期分隔条 */
let lastRenderedDay = new Date(0);

/**
 * 把时间写到一条消息上，并在需要时于它**之前**插入日期分隔条。
 *
 * 两个调用来源：
 *   · addMessage —— 渲染历史消息（时间现成）
 *   · SSE 的 message 事件 —— 实时消息的时间要等落库后才有
 *
 * ⚠️ 实时消息那一侧，user 与 assistant 的 created_at 是**同一个值**
 *    （同事务写入，now() 在事务内是常量）。于是 assistant 那条
 *    必然与 user 同一天 → 分隔条只会插在用户消息前面，不会把
 *    同一轮的一问一答劈成两半。这里不需要额外判断。
 *
 * ⚠️ 调用前 wrap **必须已经挂进 #messages**。
 *    insertBefore 的参照节点必须是父节点的子节点，否则浏览器抛 NotFoundError。
 *    这里显式判断一次而不是靠约定 —— 那次事故的代价是整页加载失败，
 *    而多一个 if 的成本是零。
 */
function stampMessage(wrap, iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return;

  const metaLine = wrap.querySelector('.msg-meta');
  if (metaLine) {
    metaLine.textContent = absTime(d);
    metaLine.title = d.toLocaleString('zh-CN');
  }

  // 已经有分隔条（或已有消息）时，同一天不重复插
  const box = $('#messages');
  if (wrap.parentNode !== box) return;

  if (!sameLocalDay(d, lastRenderedDay)) {
    lastRenderedDay = d;
    box.insertBefore(el('div', { class: 'day-divider', text: dayLabel(d) }), wrap);
  }
}

function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

/** 发送一条消息，用 SSE 逐字接收回答 */
async function sendMessage(text) {
  if (streaming) return;
  streaming = true;
  $('#btn-send').disabled = true;

  const userMsg = addMessage('user', text);
  const reply = addMessage('assistant', '');
  const replyBody = reply.querySelector('.msg-body');
  const replyMeta = reply.querySelector('.msg-meta');
  replyBody.classList.add('cursor');

  let accumulated = '';
  let meta = null;

  try {
    const res = await fetch(`${API}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(conversationId ? { conversation_id: conversationId, message: text } : { message: text }),
    });

    // 校验失败等会以普通 JSON 返回（校验发生在建立 SSE 之前）
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('响应没有内容');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;

        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }

        if (ev.type === 'token') {
          accumulated += ev.content;
          replyBody.innerHTML = renderMarkdown(accumulated);
          scrollToBottom();
        } else if (ev.type === 'message') {
          if (ev.role === 'assistant') conversationId = ev.conversation_id;
          /**
           * 时间以服务端为准（见 chat.ts 的说明）：
           * 用客户端时钟打时间是「响应到达时刻」，不是消息落库时刻。
           */
          stampMessage(ev.role === 'user' ? userMsg : reply, ev.created_at);
        } else if (ev.type === 'meta') {
          meta = ev.data;
        } else if (ev.type === 'error') {
          throw new Error(`${ev.code}: ${ev.message}`);
        }
      }
    }
  } catch (err) {
    accumulated += `\n\n[出错] ${err.message}`;
    replyBody.innerHTML = renderMarkdown(accumulated);
  } finally {
    replyBody.classList.remove('cursor');
    streaming = false;
    $('#btn-send').disabled = false;
    $('#input').focus();
  }

  // 元信息：让用户看到「它想起了什么」
  if (meta) {
    const parts = [];
    if (meta.context?.injectedMemoryCount > 0) parts.push(`召回 ${meta.context.injectedMemoryCount} 条记忆`);
    if (meta.tool_calls_executed > 0) parts.push(`调用 ${meta.tool_calls_executed} 次工具`);
    parts.push(`${meta.usage?.outputTokens ?? 0} tokens`);
    replyMeta.textContent = parts.join(' · ');

    // 抽取是后台跑的 —— 聊完去看记忆时能看到新条目
    if (meta.conversation_id) {
      setTimeout(updateMemoryHint, 4000);
    }
  }
  scrollToBottom();

  /**
   * 刷新会话列表。
   *
   * 三个原因：
   *   ① 首轮对话会**新建**会话，不刷新的话它不在列表里 ——
   *      用户会以为「聊了半天怎么没记录」
   *   ② updated_at 变了，顺序应重排（最近聊的排最前）
   *   ③ 标题是后台用 LLM 生成的，慢一两秒才落库 ——
   *      只刷一次的话列表里会一直显示占位标题（首条消息截断）。
   *      第二次刷新就能看到正式标题，这比让用户自己按 F5 好得多。
   */
  loadConversations();
  setTimeout(loadConversations, 6000);
}

/** 让侧栏/输入框附近显示「已记住多少条」，给后台抽取一个可见的反馈 */
async function updateMemoryHint() {
  try {
    const data = await api('GET', '/memories?page_size=1');
    $('#chat-hint').textContent = `已记住 ${data.pagination.total} 条`;
  } catch {
    /* 提示失败不影响使用 */
  }
}

// ============================================================
// 记忆
// ============================================================

const STATUS_LABEL = {
  active: '有效',
  conflict: '待裁决',
  superseded: '已替代',
  archived: '已归档',
  /** C39：用户明确否定的（「这条不对」）。与「已删除」是两件事 */
  rejected: '已否定',
  deleted: '已删除',
};

async function loadMemories() {
  const box = $('#mem-list');
  const q = $('#mem-search').value.trim();
  const view = $('#mem-view').value;

  box.replaceChildren(el('div', { class: 'dim', text: '加载中…' }));

  try {
    if (q.length > 0) {
      const data = await api('GET', `/memories/search?q=${encodeURIComponent(q)}&limit=20`);
      if (data.items.length === 0) {
        box.replaceChildren(el('div', { class: 'dim', text: '没有匹配的记忆。' }));
        return;
      }
      const ch = data.diagnostics?.channelHits ?? {};
      box.replaceChildren(
        el('div', {
          class: 'dim',
          text: `搜索命中 ${data.items.length} 条（向量 ${ch.vector ?? 0} / 关键词 ${ch.keyword ?? 0} / 槽位 ${ch.slot ?? 0}）`,
        }),
        ...data.items.map((m) =>
          memoryCard(m, [el('span', { class: 'score', text: m.score.toFixed(3) })])
        )
      );
      return;
    }

    const data = await api('GET', `/memories?page_size=50&view=${view}`);
    if (data.items.length === 0) {
      box.replaceChildren(el('div', { class: 'dim', text: '还没有记忆。聊几句，系统会自己整理。' }));
      return;
    }
    box.replaceChildren(
      el('div', { class: 'dim', text: `共 ${data.pagination.total} 条` }),
      ...data.items.map((m) => memoryCard(m))
    );
  } catch (err) {
    box.replaceChildren(el('div', { class: 'dim', text: `加载失败：${err.message}` }));
  }
}

function memoryCard(m, extraTags = []) {
  const tags = [
    el('span', { class: 'tag', text: m.type }),
    ...(m.predicate_key
      ? [el('span', { class: 'tag slot', text: m.predicate_key })]
      : []),
    ...(m.status && m.status !== 'active'
      ? [el('span', { class: `tag ${m.status}`, text: STATUS_LABEL[m.status] ?? m.status })]
      : []),
    ...extraTags,
  ];

  const meta = [];
  if (m.valid_from) meta.push(`${m.valid_from.slice(0, 10)} 起`);
  if (m.valid_until) meta.push(`至 ${m.valid_until.slice(0, 10)}`);
  if (m.importance_score !== undefined) meta.push(`重要度 ${m.importance_score}`);
  meta.push(relTime(m.created_at));

  const actions = el('div', { class: 'head-actions' });

  /**
   * 「这条不对」（docs/12 §方案 4 的②）。
   *
   * 只在当前有效的记忆上出现 —— 已否定/已删除的再点一次没有意义，
   * 后端也会拒绝（409）。
   *
   * 与「删除」并排而不是替换它：两者表达的意图不同，
   * 删除是「不想留着了」，否定是「这条是错的」。
   * 用户会在不同场景下用不同那个。
   */
  if (m.status === 'active') {
    actions.appendChild(
      el('button', {
        class: 'btn small',
        text: '这条不对',
        title: '否掉这条内容：立刻不再被想起，但记录保留在「全部」视图里',
        onclick: async () => {
          if (!confirm('标记这条为「不对」？\n\n它会立刻从所有回忆路径中排除，但记录仍保留（可在「全部」视图里撤回）。')) {
            return;
          }
          try {
            await api('POST', `/memories/${m.id}/reject`);
            loadMemories();
            updateMemoryHint();
          } catch (err) {
            alert(`操作失败：${err.message}`);
          }
        },
      })
    );
  }

  actions.appendChild(
    el('button', {
      class: 'btn small danger',
      text: '删除',
      onclick: async () => {
        if (!confirm('删除这条记忆？可以从「全部」视图里恢复。')) return;
        try {
          await api('DELETE', `/memories/${m.id}`);
          loadMemories();
          updateMemoryHint();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      },
    })
  );

  return el('div', { class: 'card item' }, [
    el('div', { class: 'item-head' }, [...tags, ...(meta.length ? [el('span', { class: 'dim', text: meta.join(' · ') })] : [])]),
    el('div', { class: 'item-body', text: m.content }),
    /**
     * 已删除与已否定都给「撤回」按钮 —— 两者的撤回是同一个动作
     * （POST /:id/restore），后端已支持两种来源状态（C39）。
     */
    m.status === 'deleted' || m.status === 'rejected'
      ? el('div', { class: 'head-actions' }, [
          el('button', {
            class: 'btn small',
            text: m.status === 'rejected' ? '撤回否定' : '恢复',
            onclick: async () => {
              try {
                const r = await api('POST', `/memories/${m.id}/restore`);
                alert(r.became_conflict ? '已恢复，但该槽位已被占用，转为「待裁决」' : '已恢复');
                loadMemories();
              } catch (err) {
                alert(`恢复失败：${err.message}`);
              }
            },
          }),
        ])
      : actions,
  ]);
}

// ============================================================
// 时间线
// ============================================================

/**
 * 把服务端返回的时刻渲染成日期。
 *
 * ⚠️ 用**浏览器所在时区**换算，不能 `slice(0, 10)`。
 *    event_time 是带时区的 ISO（如 `2026-09-28T16:00:00.000Z`），
 *    `slice(0, 10)` 取的是 UTC 日期 —— 北京用户会看到前一天。
 *    （服务端那侧同类写法有 9 处，见 src/shared/local-time.ts；
 *      前端这一处是第 10 处，修法相同。）
 *
 * 用浏览器时区而不是 users.timezone：用户看着自己的屏幕，
 * 浏览器的时区就是他的时区 —— 这比配置里的值更不会错。
 */
function eventDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * 事件的日期 + 时刻（仅当精度到分钟时才有时刻）。
 *
 * 日期级事件只显示「2026-09-29」—— 它的 event_time 落在当地零点，
 * 显示成「00:00」会让人以为「这件事发生在半夜」。
 */
function eventDateTime(e) {
  const date = eventDate(e.event_time);
  if (e.event_precision !== 'minute') return date;

  const d = new Date(e.event_time);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

async function loadTimeline() {
  const box = $('#tl-list');
  box.replaceChildren(el('div', { class: 'dim', text: '加载中…' }));

  const cat = $('#tl-category').value;
  const qs = cat ? `?page_size=100&category=${cat}` : '?page_size=100';

  try {
    const data = await api('GET', `/timeline${qs}`);

    // 分类下拉只填一次
    const sel = $('#tl-category');
    if (sel.options.length === 1) {
      try {
        const cats = await api('GET', '/timeline/categories');
        for (const c of cats.items) {
          sel.appendChild(el('option', { value: c.value, text: c.value }));
        }
      } catch {
        /* 分类拉不到不影响主流程 */
      }
    }

    if (data.months.length === 0) {
      box.replaceChildren(
        el('div', { class: 'dim', text: '还没有事件。对话里提到「我上周搬了家」这类事时会自动记进来。' })
      );
      return;
    }

    const nodes = [el('div', { class: 'dim', text: `共 ${data.pagination.total} 条` })];
    for (const month of data.months) {
      nodes.push(el('div', { class: 'month-head', text: `${month.month}（${month.total}）` }));
      for (const e of month.items) {
        const children = [
          el('div', { class: 'item-head' }, [
            el('span', { class: 'dim', text: eventDateTime(e) }),
            ...(e.category ? [el('span', { class: 'tag', text: e.category })] : []),
            ...(e.source_type === 'conversation' ? [el('span', { class: 'dim', text: '来自对话' })] : []),
          ]),
          el('div', { class: 'item-body', text: e.title }),
        ];
        if (e.description) children.push(el('div', { class: 'dim', text: e.description }));
        nodes.push(el('div', { class: 'card item' }, children));
      }
    }
    box.replaceChildren(...nodes);
  } catch (err) {
    box.replaceChildren(el('div', { class: 'dim', text: `加载失败：${err.message}` }));
  }
}

// ============================================================
// 目标
// ============================================================

async function loadGoals() {
  const box = $('#goal-list');
  box.replaceChildren(el('div', { class: 'dim', text: '加载中…' }));

  try {
    const data = await api('GET', '/goals?page_size=50');
    if (data.items.length === 0) {
      box.replaceChildren(
        el('div', { class: 'dim', text: '还没有目标。目标不会从对话里自动抽取 —— 你自己加更能反映真实意图。' })
      );
      return;
    }

    box.replaceChildren(
      el('div', { class: 'dim', text: `共 ${data.pagination.total} 个` }),
      ...data.items.map((g) => {
        const tags = [
          el('span', { class: `tag ${g.is_ongoing ? 'active' : 'archived'}`, text: g.status }),
          el('span', { class: 'tag', text: `优先级 ${g.priority}` }),
        ];
        if (g.target_at) tags.push(el('span', { class: 'dim', text: `目标 ${g.target_at.slice(0, 10)}` }));

        const actions = el('div', { class: 'head-actions' });

        if (g.is_ongoing) {
          actions.appendChild(
            el('button', {
              class: 'btn small',
              text: '完成',
              onclick: async () => {
                try {
                  const r = await api('PATCH', `/goals/${g.id}`, { status: 'completed' });
                  if (r.warnings) alert(r.warnings.join('\n'));
                  loadGoals();
                } catch (err) {
                  alert(`失败：${err.message}`);
                }
              },
            })
          );
          actions.appendChild(
            el('button', {
              class: 'btn small',
              text: '搁置',
              onclick: async () => {
                try {
                  await api('PATCH', `/goals/${g.id}`, { status: 'paused' });
                  loadGoals();
                } catch (err) {
                  alert(`失败：${err.message}`);
                }
              },
            })
          );
        }

        actions.appendChild(
          el('button', {
            class: 'btn small danger',
            text: '删除',
            onclick: async () => {
              if (!confirm(`删除目标「${g.title}」？`)) return;
              try {
                await api('DELETE', `/goals/${g.id}`);
                loadGoals();
                updateMemoryHint();
              } catch (err) {
                alert(`失败：${err.message}`);
              }
            },
          })
        );

        const children = [
          el('div', { class: 'item-head' }, tags),
          el('div', { class: 'item-body', text: g.title }),
        ];
        if (g.description) children.push(el('div', { class: 'dim', text: g.description }));
        children.push(actions);
        return el('div', { class: 'card item' }, children);
      })
    );
  } catch (err) {
    box.replaceChildren(el('div', { class: 'dim', text: `加载失败：${err.message}` }));
  }
}

// ============================================================
// 回顾
// ============================================================

async function generateReview() {
  const box = $('#review-out');
  const kind = $('#review-kind').value;
  const btn = $('#btn-review');

  btn.disabled = true;
  box.replaceChildren(el('div', { class: 'dim', text: '生成中…（会真实调用模型，十几秒）' }));

  try {
    const data = await api('POST', '/life-review', { kind });

    const nodes = [];

    // 材料来源：让用户知道这次回顾基于什么
    const s = data.sources_available;
    nodes.push(
      el('div', {
        class: 'dim',
        text:
          `${data.period.start.slice(0, 10)} ~ ${data.period.end.slice(0, 10)} · ` +
          `事件 ${s.events} · 记忆 ${s.memories} · 目标 ${s.goals} · 摘要 ${s.summaries}`,
      })
    );

    nodes.push(
      el('div', { class: 'card' }, [
        el('div', { class: 'review-summary', text: data.review.summary }),
        ...(data.review.themes?.length
          ? [
              el(
                'div',
                { class: 'review-themes' },
                data.review.themes.map((t) => el('span', { class: 'tag', text: t }))
              ),
            ]
          : []),
      ])
    );

    for (const h of data.review.highlights ?? []) {
      nodes.push(
        el('div', { class: 'card item highlight' }, [el('span', { text: '·' }), el('span', { text: h.text })])
      );
    }

    box.replaceChildren(...nodes);
  } catch (err) {
    box.replaceChildren(el('div', { class: 'dim', text: `生成失败：${err.message}` }));
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// 设置
// ============================================================

async function loadSettings() {
  const box = $('#settings-out');
  box.replaceChildren(el('div', { class: 'dim', text: '加载中…' }));

  try {
    const s = await api('GET', '/settings');

    const toggle = el('input', { type: 'checkbox' });
    toggle.checked = s.memory.auto_extract;
    toggle.addEventListener('change', async () => {
      try {
        await api('PATCH', '/settings', { memory: { auto_extract: toggle.checked } });
      } catch (err) {
        toggle.checked = !toggle.checked;
        alert(`保存失败：${err.message}`);
      }
    });

    box.replaceChildren(
      el('div', { class: 'card item' }, [
        el('div', { class: 'item-body' }, [el('label', {}, [toggle, el('span', { text: ' 自动从对话里整理记忆' })])]),
        el('div', {
          class: 'dim',
          text: '关掉后不再自动整理；已经记住的内容不受影响，也不会被删除。',
        }),
      ]),
      el('div', { class: 'card item' }, [
        el('div', { class: 'item-head' }, [el('span', { class: 'tag', text: '模型' })]),
        el('div', { class: 'item-body', text: `${s.model.provider} / ${s.model.model}` }),
      ]),
      el('div', { class: 'card item' }, [
        el('div', { class: 'item-head' }, [el('span', { class: 'tag', text: '时区' })]),
        el('div', { class: 'item-body', text: s.timezone }),
      ])
    );
  } catch (err) {
    box.replaceChildren(el('div', { class: 'dim', text: `加载失败：${err.message}` }));
  }
}

// ============================================================
// 事件绑定
// ============================================================

function bindEvents() {
  // ---------- 对话 ----------
  const input = $('#input');

  // 输入框随内容长高（最多 200px，超过则内部滚动）
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  });

  input.addEventListener('keydown', (e) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || streaming) return;
    input.value = '';
    input.style.height = 'auto';
    await sendMessage(text);
  });

  $('#btn-new-chat').addEventListener('click', startNewChat);

  // ---------- 记忆 ----------
  $('#mem-view').addEventListener('change', loadMemories);

  let searchTimer;
  $('#mem-search').addEventListener('input', () => {
    // 防抖：语义搜索每次都要调 embedding，不能每敲一个字就发一次
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadMemories, 450);
  });

  // ---------- 时间线 ----------
  $('#tl-category').addEventListener('change', loadTimeline);

  // ---------- 目标 ----------
  $('#btn-new-goal').addEventListener('click', () => {
    $('#goal-form').classList.toggle('hidden');
  });
  $('#btn-cancel-goal').addEventListener('click', () => {
    $('#goal-form').classList.add('hidden');
  });

  $('#goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#goal-title').value.trim();
    if (!title) return;

    const target = $('#goal-target').value;
    try {
      await api('POST', '/goals', {
        title,
        description: $('#goal-desc').value.trim() || null,
        target_at: target || null,
      });
      $('#goal-title').value = '';
      $('#goal-desc').value = '';
      $('#goal-target').value = '';
      $('#goal-form').classList.add('hidden');
      loadGoals();
      updateMemoryHint();
    } catch (err) {
      alert(`创建失败：${err.message}`);
    }
  });

  // ---------- 回顾 ----------
  $('#btn-review').addEventListener('click', generateReview);
}

/** 启动时把两个渲染入口挂到 window，供无浏览器回归测试调用（见 app.dom.test.ts） */
if (typeof window !== 'undefined') {
  window.__lifemateTestHooks = { addMessage, openConversation };
}

// ============================================================
// 启动
// ============================================================

bindEvents();
showView(currentView());
checkHealth();
updateMemoryHint();
loadConversations();

// 定期查服务状态：后端挂了应该能一眼看出来，而不是每次发消息才失败
const healthTimer = setInterval(checkHealth, 30000);
/**
 * ⚠️ unref 是给无浏览器回归测试用的（public/app.dom.test.ts）。
 *    浏览器里定时器没有 unref，所以必须先判断存在性再调用。
 *    不加这一句时，测试进程会被这个定时器永远挂住 ——
 *    实测表现为 `pnpm test` 卡满超时，而不是报失败。
 */
if (healthTimer && typeof healthTimer.unref === 'function') {
  healthTimer.unref();
}
