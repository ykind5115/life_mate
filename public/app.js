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
      for (const m of items) {
        // 只渲染 user / assistant；system 与 tool 是 Agent 内部协议，不该给用户看
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        addMessage(m.role, m.content, { skipScroll: true });
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

  $('#messages').appendChild(wrap);
  if (!opts.skipScroll) scrollToBottom();
  return wrap;
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

  addMessage('user', text);
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
   * 两个原因：
   *   ① 首轮对话会**新建**会话，不刷新的话它不在列表里 ——
   *      用户会以为「聊了半天怎么没记录」
   *   ② updated_at 变了，顺序应重排（最近聊的排最前）
   */
  loadConversations();
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
  const delBtn = el('button', {
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
  });
  actions.appendChild(delBtn);

  return el('div', { class: 'card item' }, [
    el('div', { class: 'item-head' }, [...tags, ...(meta.length ? [el('span', { class: 'dim', text: meta.join(' · ') })] : [])]),
    el('div', { class: 'item-body', text: m.content }),
    m.status === 'deleted'
      ? el('div', { class: 'head-actions' }, [
          el('button', {
            class: 'btn small',
            text: '恢复',
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
            el('span', { class: 'dim', text: e.event_time.slice(0, 10) }),
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

// ============================================================
// 启动
// ============================================================

bindEvents();
showView(currentView());
checkHealth();
updateMemoryHint();
loadConversations();

// 定期查服务状态：后端挂了应该能一眼看出来，而不是每次发消息才失败
setInterval(checkHealth, 30000);
