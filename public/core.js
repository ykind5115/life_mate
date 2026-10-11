/**
 * 前端基础设施：DOM 渲染层 + 状态层（docs/16 决策 A2）
 *
 * 【为什么需要这一层，而不是继续手写 DOM】
 *
 *   改版前 app.js 是「每个视图一个 render 函数 + 手写 createElement +
 *   散落的模块级状态」。30 个功能时还能读；这次要加到 50 多个功能点、
 *   8 个视图，手写 DOM 会有三个具体后果：
 *
 *     ① 状态同步靠人肉记：改了数据要记得手动更新界面的每一处
 *     ② 事件绑定散在各处，重新渲染后忘了重绑就静默失效
 *     ③ XSS 靠每处记得 escapeHtml —— 漏一处就是漏洞
 *
 *   这一层只解决这三件事，不引入框架、不引入构建步骤：
 *     · h()      —— 声明式建元素，**自动转义文本**
 *     · store    —— 单一状态源，订阅式重渲染
 *     · route    —— hash 路由
 *
 * 【为什么不用 innerHTML 拼字符串】
 *   本次新增的功能里有大量**用户内容直接进界面**的地方
 *   （记忆正文、人名、会话标题、工具参数键名……）。
 *   拼字符串就要求每一处都记得转义，而漏掉一处的后果是 XSS。
 *   h() 把转义做进 API：文本节点永远走 textContent，
 *   想插 HTML 必须显式用 raw()。让不安全的写法变成**更麻烦的写法**。
 */

// ============================================================
// DOM
// ============================================================

/**
 * 声明式建元素。
 *
 * 用法：
 *   h('div', { class: 'card' }, '文本', h('span', {}, '子元素'))
 *   h('button', { onclick: fn, disabled: true })
 *   h('input', { value: x, placeholder: '...' })
 *
 * 【属性口径】
 *   · 以 on 开头 → 事件监听（onclick / oninput / onsubmit…）
 *   · class / className → className
 *   · style 传对象 → 逐条 setProperty
 *   · dataset 传对象 → data-* 属性
 *   · 值为 null / undefined / false → 不设置该属性
 *   · 值为 true → 设为空属性（如 disabled）
 *   · 其余 → setAttribute
 *
 * 【为什么文本不用 innerHTML】
 *   见文件头。文本节点走 textContent，转义由浏览器负责 ——
 *   这是「不可能写错」的做法，而 escapeHtml 是「记得就没事」的做法。
 *
 * ⚠️ 本文件是**无构建步骤**的浏览器模块，因此不能出现 TypeScript
 *    语法（类型标注、export type…）。`node --check` 会直接报语法错。
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;

      if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }
      if (key === 'class' || key === 'className') {
        el.className = String(value);
        continue;
      }
      if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (v === null || v === undefined) continue;
          el.style.setProperty(prop, String(v));
        }
        continue;
      }
      if (key === 'dataset' && typeof value === 'object') {
        for (const [d, v] of Object.entries(value)) {
          if (v === null || v === undefined) continue;
          el.dataset[d] = String(v);
        }
        continue;
      }
      /**
       * ⚠️ 不能用 `instanceof HTMLInputElement`：那几个构造器在
       *    Node 环境（DOM 测试）里不存在，会直接 ReferenceError。
       *    鸭子类型判断反而更稳，也不依赖任何全局。
       */
      if (key === 'value' && 'value' in el && typeof el.value === 'string') {
        el.value = String(value);
        continue;
      }
      if (value === true) {
        el.setAttribute(key, '');
        continue;
      }
      el.setAttribute(key, String(value));
    }
  }

  appendChildren(el, children);
  return el;
}

/** 递归插入子节点。数组展开，null/undefined/false 跳过 */
export function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
      continue;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      // 文本走 textContent —— 转义交给浏览器，不存在「忘了转义」
      parent.appendChild(document.createTextNode(String(child)));
      continue;
    }
    /**
     * ⚠️ 不能用 `instanceof Node`：Node 构造器在 Node.js 环境里不存在
     *    （DOM 测试直接 ReferenceError）。用鸭子类型判断「像不像一个节点」。
     */
    if (child && typeof child === 'object' && typeof child.nodeType === 'number') {
      parent.appendChild(child);
      continue;
    }
    // 函数形态的子节点：延迟求值
    if (typeof child === 'function') child();
  }
}

/** 清空并填入内容 */
export function render(parent, ...children) {
  parent.replaceChildren();
  appendChildren(parent, children);
}

// ============================================================
// 状态
// ============================================================

/**
 * 极简订阅式状态。
 *
 * 【为什么不用事件总线】
 *   本次改版的多数交互是「改一处数据 → 重渲染一个区域」。
 *   订阅式状态直接表达这件事；事件总线会引入「谁该监听什么」的隐式知识。
 *
 * 【为什么每个视图一个 store 而不是全局一个大 store】
 *   全局 store 会让「改 A 导致 B 重渲染」变成常态，
 *   而 B 的重渲染会重置 B 的滚动位置与输入焦点。
 *   按视图分治是这里最省事的正确做法。
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get() {
      return state;
    },
    /** 合并式更新（浅合并，PATCH 语义） */
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state);
    },
    /** 替换式更新（整体换掉，用于列表刷新） */
    replace(next) {
      state = next;
      for (const fn of listeners) fn(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ============================================================
// 路由
// ============================================================

/** 解析 `#/memories/abc?x=1` → { name: 'memories', params: ['abc'], query: {x:'1'} } */
export function parseHash(hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter((s) => s.length > 0);

  const query = {};
  for (const pair of queryPart.split('&')) {
    if (pair.length === 0) continue;
    const [k, v = ''] = pair.split('=');
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
  }

  return { name: segments[0] ?? 'chat', params: segments.slice(1), query };
}

/** 跳转到某个视图 */
export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
}

/**
 * 注册 hash 路由。
 *
 * 返回取消订阅函数 —— 单页应用不需要，但测试需要（避免用例互相干扰）。
 */
export function onRouteChange(handler) {
  const fire = () => handler(parseHash(window.location.hash));
  window.addEventListener('hashchange', fire);
  fire();
  return () => window.removeEventListener('hashchange', fire);
}

// ============================================================
// 格式化
// ============================================================

/**
 * 把 ISO 时刻渲染成日期。
 *
 * ⚠️ 用**浏览器所在时区**换算，不能 `iso.slice(0, 10)`。
 *    `slice` 取的是 UTC 日期 —— 北京用户凌晨 0-8 点的事会显示成前一天。
 *    服务端那侧同类写法曾有 9 处（见 src/shared/local-time.ts），
 *    前端这一处是第 10 处，修法相同。
 */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 日期 + 时刻（HH:mm） */
export function formatDateTime(iso) {
  const date = formatDate(iso);
  if (!date) return '';
  const d = new Date(iso);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * 事件的日期显示：day 精度只显示日期。
 *
 * 日期级事件的 event_time 落在**当地零点** ——
 * 显示成「00:00」会让人以为「这件事发生在半夜」（见 docs/14 / C40）。
 */
export function formatEventTime(iso, precision) {
  return precision === 'minute' ? formatDateTime(iso) : formatDate(iso);
}

/** 相对时间：「3 分钟前」「昨天 14:20」 */
export function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);

  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;

  const hours = Math.round(mins / 60);
  if (hours < 24 && d.getDate() === new Date().getDate()) return `${hours} 小时前`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days === 1) return `昨天 ${formatDateTime(iso).slice(11)}`;
  if (days < 7) return `${days} 天前`;
  return formatDate(iso);
}

/** 数字千分位（token 数等） */
export function formatNumber(n) {
  return Number(n ?? 0).toLocaleString('zh-CN');
}

/** 毫秒渲染成人话：420ms / 1.2s */
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 连续触发只执行最后一次（搜索框用）。
 *
 * 为什么不用 debounce 包：这是唯一的用法，
 * 为它引一个依赖不值得，写 8 行就够。
 */
export function debounce(fn, waitMs) {
  let timer;
  return (...args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  };
}

// ============================================================
// 反馈
// ============================================================

let toastHost = null;

/**
 * 轻提示。
 *
 * 【为什么需要它】本次新增了大量写操作（否决、恢复、删除、改设置…）。
 *   此前失败时往列表里塞一行红字，用户不一定会看到 ——
 *   而那些操作失败必须被看见（否则会以为生效了）。
 */
export function toast(message, kind = 'info') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }

  const node = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(node);

  // 动画结束后移除；同时兜底一个定时器（万一 transitionend 没触发）
  const remove = () => node.remove();
  node.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 4000);
}
