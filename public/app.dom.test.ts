/**
 * 前端 DOM 行为的回归测试（无需浏览器）
 *
 * 【它为什么存在】
 *   🔴 2026-09-26 实际事故：打开任意一个历史会话，界面显示
 *      「加载失败：Failed to execute 'insertBefore' on 'Node': …」
 *   原因是先调 stampMessage（内部 insertBefore），后把消息节点挂进 DOM。
 *   当时 **399 个 Node 测试全绿**，因为测试跑不到浏览器 DOM。
 *
 *   这个文件补上那一层：用一个**忠实模拟浏览器语义**的最小 DOM
 *   （关键：参照节点不是子节点时必须抛错），把 app.js **真正执行**一遍。
 *
 * 【为什么不用 jsdom / happy-dom】
 *   前端是零依赖、零构建的（docs/16 决策 A）。
 *   为几个断言引入一个 DOM 实现，会让「pnpm i 之后能不能跑」多一个变量。
 *   这里只需要 DOM 的**契约**，不需要它的实现 —— 手写更可控。
 *
 * 【局限（必须知道）】
 *   验证的是**逻辑与调用顺序**，不是渲染效果。
 *   CSS 对不对、力导向图好不好看，仍然只能在真实浏览器里看。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// ============================================================
// 最小 DOM —— 契约与浏览器一致的那部分
// ============================================================

class DOMExceptionLike extends Error {
  constructor(message: string, readonly domName: string) {
    super(message);
  }
}

class StubNode {
  parentNode: StubNode | null = null;
  childNodes: StubNode[] = [];
  textContent = '';
  className = '';
  value = '';
  title = '';
  checked = false;
  disabled = false;
  /**
   * core.js 的 appendChildren 用鸭子类型判断「像不像节点」
   * （不能用 instanceof Node —— 那个构造器在 Node 环境不存在）。
   * 因此这里必须提供 nodeType。
   */
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  readonly style = {
    setProperty: (): void => {},
    removeProperty: (): void => {},
  };
  /** 记录被设置过的 innerHTML（markdown 渲染走这条路） */
  innerHTML = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  /**
   * ⚠️ `id` 必须是 attrs 的**视图**，不能是独立字段。
   *
   * 真实 DOM 里 `el.setAttribute('id', 'x')` 之后 `el.id === 'x'` ——
   * 属性与特性是同一份数据。app.js 的 showView 靠 `el.id` 判断哪个视图该激活：
   *   el.classList.toggle('active', el.id === `view-${view}`)
   *
   * 实测踩到（2026-10-08）：桩把 id 只存进 attrs 而不暴露成属性，
   * 于是 `el.id` 永远是 undefined，**所有视图都不激活** ——
   * 三个用例失败，而产品代码完全正确。
   * 这类「桩不比真实环境严格」的缺陷最危险：它在测一个不存在的页面。
   */
  get id(): string {
    return this.attrs.get('id') ?? '';
  }

  set id(v: string) {
    this.attrs.set('id', v);
  }

  /**
   * `dataset` 同理：真实 DOM 里 `data-nav="chat"` 对应
   * `el.dataset.nav === 'chat'`。app.js 的导航高亮靠它。
   */
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) {
      if (!k.startsWith('data-')) continue;
      // data-nav → nav；data-foo-bar → fooBar（与浏览器一致）
      const camel = k
        .slice(5)
        .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      out[camel] = v;
    }
    return out;
  }

  get classList() {
    const self = this;
    const parts = (): string[] => self.className.split(' ').filter(Boolean);
    const has = (c: string): boolean => parts().includes(c);
    const set = (list: string[]): void => {
      self.className = list.join(' ');
    };
    return {
      add(c: string) {
        if (!has(c)) set([...parts(), c]);
      },
      remove(c: string) {
        set(parts().filter((x) => x !== c));
      },
      toggle(c: string, force?: boolean) {
        const want = force ?? !has(c);
        if (want) this.add(c);
        else this.remove(c);
      },
      contains(c: string) {
        return has(c);
      },
    };
  }

  appendChild<T extends StubNode>(child: T): T {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  /**
   * ⚠️ 整个文件的关键：**忠实复现浏览器的报错条件**。
   *
   * 浏览器的规则是 refNode 必须是 this 的子节点，否则抛 NotFoundError
   * （refNode 为 null 时是 append，不报错）。
   * 若这里宽容处理，那次事故就测不出来 —— 测试比浏览器宽松，
   * 等于一个假测试。
   */
  insertBefore<T extends StubNode>(newNode: T, refNode: StubNode | null): T {
    if (refNode === null) return this.appendChild(newNode);

    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) {
      throw new DOMExceptionLike(
        "Failed to execute 'insertBefore' on 'Node': " +
          'The node before which the new node is to be inserted is not a child of this node.',
        'NotFoundError'
      );
    }

    if (newNode.parentNode) newNode.remove();
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx !== -1) this.parentNode.childNodes.splice(idx, 1);
    this.parentNode = null;
  }

  replaceChildren(...nodes: StubNode[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(n);
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(): void {}

  focus(): void {}
  select(): void {}

  /** 深度优先找第一个匹配的节点 */
  private find(sel: string): StubNode | null {
    for (const c of this.childNodes) {
      if (matches(c, sel)) return c;
      const deeper = c.find(sel);
      if (deeper) return deeper;
    }
    return null;
  }

  querySelector(sel: string): StubNode | null {
    return this.find(sel);
  }

  querySelectorAll(sel: string): StubNode[] {
    const out: StubNode[] = [];
    const walk = (n: StubNode): void => {
      for (const c of n.childNodes) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  /**
   * 结构快照，用来断言消息与分隔条的**顺序**与内容。
   *
   * 叶子节点带上文本 —— 否则「加载失败：…」这类提示在快照里
   * 只剩一个 `DIV`，断言就得改成读整棵树的拼接字符串，
   * 那种断言一旦失败很难看出问题在哪。
   */
  outline(): string[] {
    const id = this.attrs.get('id');
    const cls = this.className.split(' ').filter(Boolean).join('.');
    const label = `${this.tagName}${id ? `#${id}` : ''}${cls ? `.${cls}` : ''}`;

    if (this.childNodes.length === 0) {
      return [this.textContent ? `${label}«${this.textContent}»` : label];
    }

    const out = [label];
    for (const c of this.childNodes) out.push(...c.outline());
    return out;
  }

  /** 直接子节点里，指定类名的那些 */
  childrenWithClass(cls: string): StubNode[] {
    return this.childNodes.filter((c) => c.classList.contains(cls));
  }

  /** 递归收集指定类名的后裔（断言用） */
  allWithClass(cls: string): StubNode[] {
    return this.querySelectorAll(`.${cls}`);
  }

  /** 整棵子树的可见文本 */
  text(): string {
    if (this.childNodes.length === 0) return this.textContent;
    return this.childNodes.map((c) => c.text()).join(' ');
  }
}

/** 只支持 app.js 实际用到的选择器：.class / #id / tag / [attr="v"] */
function matches(node: StubNode, sel: string): boolean {
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return node.attrs.get('id') === sel.slice(1);

  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (attr) {
    const key = attr[1]!;
    const want = attr[2];
    if (key === 'data-nav') {
      return node.attrs.has('data-nav') && (want === undefined || node.attrs.get('data-nav') === want);
    }
    return node.attrs.has(key) && (want === undefined || node.attrs.get(key) === want);
  }

  return node.tagName === sel.toUpperCase();
}

/**
 * 页面里所有被 app.js 用 getElementById 取的元素。
 *
 * ⚠️ 新增 id 时要同步这里：未登记的 id 会返回一个挂在 root 下的空节点，
 *    于是「元素找不到」这类真问题会被掩盖成「元素是空的」。
 */
const ELEMENT_IDS = [
  'health',
  'conversations',
  'messages',
  'chat-side',
  'input',
  'composer',
  'btn-new-chat',
  'btn-send',
  'mem-list',
  'mem-search',
  'mem-view',
  'btn-create-memory',
  'tl-list',
  'tl-category',
  'btn-new-event',
  'graph-box',
  'rel-list',
  'rel-search',
  'btn-new-relation',
  'goal-list',
  'btn-new-goal',
  'review-kind',
  'review-custom',
  'review-from',
  'review-to',
  'review-out',
  'btn-review',
  'settings-out',
  /**
   * 手机专用控件（2026-10-13 加，docs/18 §移动端）。
   *
   * ⚠️ 桩里必须登记它们：app.js 的 bindChrome 会
   *    `document.getElementById('btn-mobile-conv-list').onclick = ...`，
   *    未登记的 id 会走 buildDom 的兜底分支造一个新节点 ——
   *    那样测试就在给一个**不在真实页面树里**的节点绑事件，
   *    于是「点了没反应」这类问题测不出来。
   */
  'btn-mobile-conv-list',
  'btn-mobile-back-to-chat',
  'btn-mobile-memories',
  'mobile-chat-title',
] as const;

const VIEW_NAMES = ['chat', 'memories', 'timeline', 'graph', 'relations', 'goals', 'review', 'settings'] as const;

const NAV_NAMES = ['chat', 'memories', 'timeline', 'graph', 'relations', 'goals', 'review', 'settings'] as const;

interface Dom {
  root: StubNode;
  /** 手机两栏切换的容器（见 buildDom） */
  chatLayout: StubNode;
  get: (id: string) => StubNode;
  view: (name: string) => StubNode;
  nav: (name: string) => StubNode;
}

function buildDom(): Dom {
  const root = new StubNode('body');
  const byId = new Map<string, StubNode>();

  for (const id of ELEMENT_IDS) {
    const n = new StubNode('div');
    n.attrs.set('id', id);
    byId.set(id, n);
    root.appendChild(n);
  }
  for (const v of VIEW_NAMES) {
    const n = new StubNode('section');
    n.attrs.set('id', `view-${v}`);
    /**
     * ⚠️ 必须带上 `view` 类 —— 真实 index.html 里的视图是
     *    `<section class="view" id="view-chat">`，而 showView 靠
     *    `document.querySelectorAll('.view')` 逐个切 active，
     *    再靠 `el.id === 'view-' + name` 决定谁激活。
     *
     *    实测踩到：桩里漏了这个类，于是 .view 一个都查不到，
     *    showView 什么也没切 —— 三个用例失败，而产品代码是对的。
     *    桩与真实 DOM 的形状不一致，测试就在测一个不存在的页面。
     */
    n.className = v === 'chat' ? 'view active' : 'view';
    byId.set(`view-${v}`, n);
    root.appendChild(n);
  }
  for (const v of NAV_NAMES) {
    const n = new StubNode('a');
    n.attrs.set('data-nav', v);
    root.appendChild(n);
  }

  /**
   * .chat-layout 容器。
   *
   * ⚠️ app.js 的 renderMobilePane 会
   *    `document.querySelector('.chat-layout')` 并在它身上切
   *    `is-mobile-list` 类。真实 index.html 里它包着「历史会话 + 消息」
   *    两块；桩里只要有这个带类的节点，媒体查询之外的逻辑就能被测到。
   *    （CSS 本身在媒体查询下的表现这里测不了 —— 见文件末尾的说明。）
   */
  const chatLayout = new StubNode('div');
  chatLayout.className = 'chat-layout';
  root.appendChild(chatLayout);

  return {
    root,
    chatLayout,
    get(id: string): StubNode {
      const found = byId.get(id);
      if (found) return found;
      /**
       * 未登记的 id 返回一个挂在 root 下的空节点，而不是 null ——
       * app.js 里大量 `$(...).addEventListener`，返回 null 会炸在无关的地方，
       * 让真正的失败被掩盖。
       */
      const fresh = new StubNode('div');
      fresh.attrs.set('id', id);
      byId.set(id, fresh);
      root.appendChild(fresh);
      return fresh;
    },
    view(name: string): StubNode {
      return byId.get(`view-${name}`)!;
    },
    nav(name: string): StubNode {
      return root.querySelectorAll('[data-nav]').find((n) => n.attrs.get('data-nav') === name)!;
    },
  };
}

// ============================================================
// 把 app.js 真正跑起来
// ============================================================

type AppModule = Record<string, unknown>;

interface Harness {
  dom: Dom;
  app: AppModule;
}

/**
 * 每个用例全新 import —— app.js 有模块级状态（store、抽屉、当前视图），
 * 复用会让用例互相干扰。
 *
 * ⚠️ **routes 的 key 必须带方法前缀**，形如 `'GET /conversations/c1'`。
 *
 *    实测（2026-10-13，写手机布局用例时踩到）：
 *    桩是这么查表的 ——
 *        const key = `${init?.method ?? 'GET'} ${url.replace('/api/v1','')}`
 *    而我一开始按 `'/conversations/c1'` 传，于是**一次都没命中**，
 *    拿到的全是 `data: {}`。
 *
 *    更麻烦的是它**不报错**：现有用例大多只断言「不抛错」「渲染出提示」，
 *    空数据也满足，所以这个不一致一直没暴露出来。
 *    我是因为新用例断言了**会话标题**（必须有真数据）才发现。
 *
 *    教训：桩的查表命中失败要能看见 —— 现在带 DSH_DOM_DEBUG=1 跑会打印
 *    「命中= true/false」。写需要真数据的新用例时先打开它。
 *
 * @param routes  假的 API 响应，key 形如 'GET /conversations/c1'
 * @param failures 需要模拟失败的 key（同样带方法前缀）
 * @param hash    启动时的 location.hash（默认 '#/chat'）。
 *                手机首屏靠它决定显示会话列表还是消息（见 app.js 的 boot）。
 */
async function bootApp(
  routes: Record<string, unknown> = {},
  failures: string[] = [],
  hash = '#/chat'
): Promise<Harness> {
  const dom = buildDom();

  const globals = globalThis as Record<string, unknown>;

  globals['document'] = {
    readyState: 'complete',
    body: dom.root,
    getElementById: (id: string) => dom.get(id),
    querySelector: (sel: string) => dom.root.querySelector(sel),
    querySelectorAll: (sel: string) => dom.root.querySelectorAll(sel),
    createElement: (tag: string) => new StubNode(tag),
    createTextNode: (text: string) => {
      const n = new StubNode('#text');
      n.textContent = text;
      return n;
    },
    addEventListener: (): void => {},
  };

  globals['location'] = { hash };

  globals['window'] = {
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    location: { hash },
    devicePixelRatio: 1,
    setInterval: () => 0,
    clearInterval: (): void => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: (): void => {},
    setTimeout: (fn: () => void) => {
      // 测试里不真的等定时器；直接不执行（避免用例结束后乱跑）
      void fn;
      return 0;
    },
  };

  globals['requestAnimationFrame'] = () => 0;
  globals['cancelAnimationFrame'] = (): void => {};
  /**
   * ⚠️ 必须替换**全局** setInterval —— app.js 里 checkHealth 是
   *    `setInterval(checkHealth, 30_000)`，那用的是全局定时器，
   *    真的建起来之后 Node 进程不会退出，测试会挂住不返回
   *    （实测踩到：跑了 300 秒还没结束）。
   */
  globals['setInterval'] = () => 0;
  globals['clearInterval'] = (): void => {};
  globals['setTimeout'] = (fn: () => void) => {
    // 测试里不真的等定时器：直接不执行，避免用例结束后乱跑
    void fn;
    return 0;
  };
  globals['clearTimeout'] = (): void => {};
  globals['ResizeObserver'] = class {
    observe(): void {}
    disconnect(): void {}
  };
  /**
   * ⚠️ navigator 在 Node 21+ 是 globalThis 上的 getter-only 属性，
   *    直接赋值会抛 "Cannot set property navigator of #<Object> which has only a getter"。
   *    必须用 defineProperty 覆盖。
   */
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });

  globals['fetch'] = async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace('/api/v1', '')}`;

    /**
     * 查表命中失败时**默认无声** —— 返回的是 `data: {}`，
     * 而「渲染出空数据」在多数断言下看起来完全正常。
     * 实测踩到过（见 bootApp 的注释）。写需要真数据的新用例时，
     * 先用 DSH_DOM_DEBUG=1 跑一次确认命中。
     */
    if (process.env['DSH_DOM_DEBUG']) console.log('[fetch]', key, '| 命中=', key in routes);

    if (failures.includes(key)) {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: '服务内部错误' } }),
        json: async () => ({ error: { message: '服务内部错误' } }),
      } as unknown as Response;
    }

    const hit = routes[key];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: hit ?? {} }),
      json: async () => ({ success: true, data: hit ?? {} }),
    } as unknown as Response;
  };

  const app = (await import(`./app.js?fresh=${Math.random()}`)) as AppModule;
  return { dom, app };
}

/** 从渲染出的节点里取纯文本 */
function textOf(node: StubNode | null | undefined): string {
  return node ? node.text() : '';
}

// ============================================================
// 消息渲染与日期分隔条（那次事故的回归）
// ============================================================

test('🔴 回归：消息渲染不抛 insertBefore 错误，且日期分隔条真的插进去', async () => {
  /**
   * 断言分两层 —— **两层缺一不可**：
   *   ① 不抛错（浏览器里的表现是整页「加载失败」）
   *   ② 分隔条**真的插进去了**
   *
   * ⚠️ 只断言 ① 会让这个测试变成假的。实测过：修复时顺手加了一句
   *    防御性 return，于是顺序写错时它**静默 return**、什么也不插 ——
   *    异常没了，但分隔条也没了。只断言「不抛错」的版本在故意写坏顺序后
   *    **依然全绿**，等于没测。
   */
  const { dom, app } = await bootApp();

  const chat = app['chat'] as { set: (p: unknown) => void };
  const renderMessages = app['renderMessages'] as () => void;

  chat.set({
    messages: [
      { id: 'm1', role: 'user', content: '第一条', created_at: '2026-09-24T00:51:00Z' },
      { id: 'm2', role: 'assistant', content: '第二条', created_at: '2026-09-24T00:51:00Z' },
    ],
    loading: false,
    detail: null,
  });

  assert.doesNotThrow(renderMessages, '渲染消息不该抛 insertBefore 错误');

  const box = dom.get('messages');
  assert.equal(box.childrenWithClass('day-sep').length, 1, '同一时刻的两条只插一条分隔条');
  assert.equal(box.childrenWithClass('msg').length, 2);

  // 分隔条必须在消息**之前** —— 否则用户与模型都失锚
  assert.deepEqual(
    box.childNodes.map((c) => (c.classList.contains('day-sep') ? 'D' : c.classList.contains('msg') ? 'M' : '?')),
    ['D', 'M', 'M']
  );
});

test('跨天的历史消息各插一条分隔条，且顺序正确', async () => {
  const { dom, app } = await bootApp();

  (app['chat'] as { set: (p: unknown) => void }).set({
    messages: [
      { id: 'm1', role: 'user', content: '第一天', created_at: '2026-09-24T00:51:00Z' },
      { id: 'm2', role: 'assistant', content: '第一天答', created_at: '2026-09-24T00:51:00Z' },
      { id: 'm3', role: 'user', content: '第三天', created_at: '2026-09-26T08:00:00Z' },
    ],
    loading: false,
    detail: null,
  });

  (app['renderMessages'] as () => void)();

  const box = dom.get('messages');
  assert.equal(box.childrenWithClass('day-sep').length, 2, '跨了两天，应有两条分隔条');
  assert.deepEqual(
    box.childNodes.map((c) => (c.classList.contains('day-sep') ? 'D' : c.classList.contains('msg') ? 'M' : '?')),
    ['D', 'M', 'M', 'D', 'M']
  );
});

test('非法时间字符串被忽略，不抛错也不写坏时间', async () => {
  const { dom, app } = await bootApp();

  (app['chat'] as { set: (p: unknown) => void }).set({
    messages: [{ id: 'm1', role: 'user', content: '时间坏了', created_at: '不是时间' }],
    loading: false,
    detail: null,
  });

  assert.doesNotThrow(() => (app['renderMessages'] as () => void)());
  assert.equal(dom.get('messages').childrenWithClass('day-sep').length, 0);
});

test('🔴 消息正文先转义再加标签（XSS 防线）', async () => {
  /**
   * 消息正文是全站唯一用 innerHTML 的地方（markdown 渲染）。
   * renderMarkdown 先整体转义再加标签 —— 这个顺序反了就是 XSS。
   * 这里守的是**顺序**：脚本标签必须以转义形态出现。
   */
  const { app } = await bootApp();
  const messageNode = app['messageNode'] as (m: unknown) => StubNode;

  const node = messageNode({
    id: 'x',
    role: 'assistant',
    content: '<script>alert(1)</script> 以及 **加粗**',
    created_at: '2026-09-24T00:51:00Z',
  });

  const content = node.querySelector('.msg-content')!;
  assert.doesNotMatch(content.innerHTML, /<script>/, '脚本标签必须被转义，不能原样进 innerHTML');
  assert.match(content.innerHTML, /&lt;script&gt;/, '应以转义形态出现');
  assert.match(content.innerHTML, /<strong>加粗<\/strong>/, 'markdown 加粗仍应生效');
});

test('用户的原话不做 markdown 渲染（他写什么就显示什么）', async () => {
  const { app } = await bootApp();
  const messageNode = app['messageNode'] as (m: unknown) => StubNode;

  const node = messageNode({
    id: 'x',
    role: 'user',
    content: '我说的是 **两个星号**',
    created_at: '2026-09-24T00:51:00Z',
  });

  const content = node.querySelector('.msg-content')!;
  assert.equal(content.innerHTML, '', '用户消息不该走 innerHTML');
  assert.equal(content.textContent, '我说的是 **两个星号**');
});

// ============================================================
// 打开会话（那条端到端路径）
// ============================================================

test('🔴 回归：openConversation 渲染历史时，分隔条真的插进去了', async () => {
  const { dom, app } = await bootApp({
    'GET /conversations/c1': {
      id: 'c1',
      title: '测试会话',
      status: 'active',
      messages: [
        { id: 'm1', role: 'user', content: '早', created_at: '2026-09-24T00:51:00Z' },
        { id: 'm2', role: 'assistant', content: '早', created_at: '2026-09-24T00:51:00Z' },
        { id: 'm3', role: 'user', content: '隔了两天', created_at: '2026-09-26T08:00:00Z' },
      ],
    },
    'GET /conversations/c1/memories': { items: [], total: 0 },
  });

  const openConversation = app['openConversation'] as (id: string, o?: unknown) => Promise<void>;
  await assert.doesNotReject(() => openConversation('c1', { silent: true }));

  const box = dom.get('messages');
  assert.doesNotMatch(textOf(box), /加载失败/, '不该出现加载失败提示');
  assert.equal(box.childrenWithClass('msg').length, 3, '三条消息都应渲染出来');
  assert.equal(box.childrenWithClass('day-sep').length, 2, '跨天两处各一条分隔条');
});

test('已删除的会话显示删除提示，而不是空白', async () => {
  const { dom, app } = await bootApp({
    'GET /conversations/c2': {
      id: 'c2',
      title: '[已删除的对话]',
      status: 'deleted',
      deleted_at: '2026-09-29T05:00:00Z',
      messages: [],
    },
    'GET /conversations/c2/memories': { items: [], total: 0 },
  });

  await (app['openConversation'] as (id: string, o?: unknown) => Promise<void>)('c2', { silent: true });
  assert.match(textOf(dom.get('messages')), /已删除/);
});

test('openConversation 的 HTTP 失败被渲染成提示，不抛到调用方', async () => {
  const { dom, app } = await bootApp({}, ['GET /conversations/c3']);

  await assert.doesNotReject(() =>
    (app['openConversation'] as (id: string, o?: unknown) => Promise<void>)('c3', { silent: true })
  );
  assert.match(textOf(dom.get('messages')), /加载失败/);
});

// ============================================================
// 记忆：概览、待裁决、轨迹
// ============================================================

test('记忆概览渲染出各项计数，待裁决为 0 时不标红', async () => {
  const { app } = await bootApp();
  const overviewRow = app['overviewRow'] as (o: unknown) => StubNode;

  const hot = overviewRow({ current: 66, conflict: 23, superseded: 1, archived: 0, rejected: 0, deleted: 0, total: 90 });
  assert.equal(hot.childrenWithClass('stat').length, 6);
  assert.equal(hot.querySelector('.hot') !== null, true, '有待裁决时应标红');
  assert.match(textOf(hot), /23/);

  const calm = overviewRow({ current: 90, conflict: 0, superseded: 0, archived: 0, rejected: 0, deleted: 0, total: 90 });
  assert.equal(calm.querySelector('.hot'), null, '没有待裁决时不该标红');
});

test('待裁决的记忆带着 conflict 类与「去裁决」按钮', async () => {
  const { app } = await bootApp();
  const memoryItem = app['memoryItem'] as (m: unknown) => StubNode;

  const node = memoryItem({
    id: 'm1',
    type: 'fact',
    content: '用户住在杭州',
    status: 'conflict',
    importance_score: 0.7,
    source_count: 2,
  });

  assert.equal(node.classList.contains('conflict'), true);
  assert.match(textOf(node), /待裁决/);
  assert.match(textOf(node), /去裁决/);
});

test('当前有效的记忆没有「去裁决」按钮（只有「这条不对」）', async () => {
  const { app } = await bootApp();
  const memoryItem = app['memoryItem'] as (m: unknown) => StubNode;

  const node = memoryItem({ id: 'm2', type: 'fact', content: 'x', status: 'active', importance_score: 0.5 });
  assert.doesNotMatch(textOf(node), /去裁决/);
  assert.match(textOf(node), /这条不对/);
});

test('轨迹面板：没有 agent 数据时返回空节点，不抛错', async () => {
  /**
   * 改版前的消息（以及用户消息）没有 metadata.agent。
   * 这条守的是「不能因为缺轨迹而把整条消息渲染炸掉」。
   */
  const { app } = await bootApp();
  const tracePanel = app['tracePanel'] as (m: unknown) => StubNode;

  assert.doesNotThrow(() => tracePanel({}));
  assert.equal(textOf(tracePanel({})), '');
});

test('轨迹面板渲染出检索与注入信息，且工具参数只显示键名', async () => {
  const { app } = await bootApp();
  const tracePanel = app['tracePanel'] as (m: unknown) => StubNode;

  const node = tracePanel({
    agent: {
      model: 'deepseek-flash',
      promptVersion: 'v2',
      iterations: 1,
      toolCallsExecuted: 1,
      usage: { inputTokens: 1388, outputTokens: 101, reasoningTokens: 60 },
      timingsMs: { agentTotal: 1136, retrieval: 116 },
      context: { historyCount: 14, injectedMemoryCount: 8, approxTokens: 3137 },
      retrieval: {
        performed: true,
        channelHits: { vector: 38, keyword: 0, slot: 0 },
        fusedCount: 38,
        returned: 8,
        degradations: ['embedding_unavailable'],
      },
      injectedMemories: [{ id: 'abcdef01-0000-4000-8000-000000000000', type: 'fact', score: 0.4993 }],
      toolCalls: [{ name: 'search_memory', argumentKeys: ['query'], resultChars: 3120, truncated: false }],
    },
  });

  const text = textOf(node);
  assert.match(text, /deepseek-flash/);
  assert.match(text, /v2/);
  assert.match(text, /1,388|1388/, 'token 数应渲染出来');
  assert.match(text, /8/, '注入记忆条数');
  assert.match(text, /embedding_unavailable/, '降级原因要显示');
  assert.match(text, /search_memory/);
  assert.match(text, /query/, '参数键名要显示');
  /**
   * 🔴 关键：轨迹里**没有**工具参数的值（§16.2 禁止正文副本进 JSONB）。
   *    这里守的是前端也不会凭空造出「值」这一栏。
   */
  assert.doesNotMatch(text, /参数值|arguments"/);
});

// ============================================================
// 时间线
// ============================================================

test('day 精度的事件只显示日期，不显示 00:00', async () => {
  /**
   * 日期级事件的 event_time 落在**当地零点**（C40）。
   * 显示成「00:00」会让人以为这件事发生在半夜 —— 一个不存在的时刻。
   */
  const { app } = await bootApp();
  const eventItem = app['eventItem'] as (e: unknown) => StubNode;

  const dayPrecision = eventItem({
    id: 'e1',
    title: '确定录用的候选人',
    event_time: '2026-09-28T16:00:00.000Z', // = 北京 09-29 00:00
    event_precision: 'day',
    category: 'work',
    source_type: 'conversation',
  });
  const dateText = textOf(dayPrecision);
  assert.match(dateText, /2026-09-29/, '应按浏览器时区还原成 09-29');
  assert.doesNotMatch(dateText, /00:00/, '日期级事件不该显示时刻');

  const minutePrecision = eventItem({
    id: 'e2',
    title: '上午面试',
    event_time: '2026-09-29T02:30:00.000Z', // = 北京 10:30
    event_precision: 'minute',
    category: 'work',
    source_type: 'manual',
  });
  assert.match(textOf(minutePrecision), /10:30/, 'minute 精度要显示时刻');
  assert.match(textOf(minutePrecision), /手动补录/);
});

// ============================================================
// 目标
// ============================================================

test('目标进度条只在同时有起止时间时才画', async () => {
  /**
   * 没有起点时画一条 0% 的进度条等于编造信息 ——
   * 用户会以为「进度是 0」而不是「这个目标没设时间」。
   */
  const { app } = await bootApp();
  const progressBar = app['progressBar'] as (g: unknown) => StubNode | null;

  assert.equal(progressBar({ started_at: null, target_at: '2026-12-31T00:00:00Z' }), null);
  assert.equal(progressBar({ started_at: '2026-01-01T00:00:00Z', target_at: null }), null);
  assert.notEqual(progressBar({ started_at: '2026-01-01T00:00:00Z', target_at: '2026-12-31T00:00:00Z' }), null);
  // 起止顺序反了也不画（那是个坏数据，不该渲染成一个看似正常的条）
  assert.equal(progressBar({ started_at: '2026-12-31T00:00:00Z', target_at: '2026-01-01T00:00:00Z' }), null);
});

// ============================================================
// 记忆来源（「它凭什么记得」）
// ============================================================

test('来源显示会话标题与原话引用', async () => {
  const { app } = await bootApp();
  const sourceNode = app['sourceNode'] as (s: unknown) => StubNode;

  const content = '内网的，连不上互联网，只能自己一个一个点着试试';

  const node = sourceNode({
    id: 's1',
    source_type: 'conversation',
    message_id: 'm1',
    conversation_id: 'c1',
    conversation_title: '中午问候与午休闲聊',
    message_content: content,
    // ⚠️ 必须等于正文长度才代表「没截断」——
    //    第一版这里写死 24，而正文其实更长，于是测试自己造出了
    //    「已截断」的显示，断言反过来失败。夹具本身要自洽。
    message_chars: content.length,
    message_created_at: '2026-10-09T04:23:14.482Z',
    created_at: '2026-10-09T04:23:20.518Z',
  });

  const text = textOf(node);
  assert.match(text, /中午问候与午休闲聊/, '要显示会话标题，否则用户不知道去哪找');
  assert.match(text, /内网的，连不上互联网/, '必须显示原话 —— 这是「它凭什么记得」的答案');
  assert.doesNotMatch(text, /已截断/, '没截断时不该说截断');
});

test('正文长度与原始长度相同时不显示「已截断」', async () => {
  // 边界：完全不截断（截断逻辑是 content.length > maxChars 才切）
  const { app } = await bootApp();
  const sourceNode = app['sourceNode'] as (s: unknown) => StubNode;

  const node = sourceNode({
    id: 's1b',
    source_type: 'conversation',
    conversation_id: 'c1',
    conversation_title: '短句',
    message_content: '就一句话',
    message_chars: 4,
    message_created_at: '2026-10-09T04:23:14.482Z',
  });

  assert.doesNotMatch(textOf(node), /已截断/);
});

test('🔴 原话被截断时必须说明还有多少字（不能假装是全文）', async () => {
  /**
   * 后端把来源正文截到 300 字（来源列表只需要「让你认出这是哪句话」）。
   * 截断本身没问题，**不告诉用户**才是问题 ——
   * 那会让人以为记忆只依据了这么一点内容。
   */
  const { app } = await bootApp();
  const sourceNode = app['sourceNode'] as (s: unknown) => StubNode;

  const node = sourceNode({
    id: 's2',
    source_type: 'conversation',
    conversation_id: 'c1',
    conversation_title: '长对话',
    message_content: 'A'.repeat(300),
    message_chars: 1024,
    message_created_at: '2026-10-09T04:23:14.482Z',
  });

  const text = textOf(node);
  assert.match(text, /已截断/, '截断要显式说出来');
  assert.match(text, /1024/, '要给出完整长度');
});

test('来源消息已被物理删除时，说清「已删除」而不是显示空白', async () => {
  /**
   * 会话删除会把消息物理删掉（C29），而来源行按设计保留（C30 的反面：
   * 还有其它来源的记忆不该被删）。此时 conversation_id 与正文都取不到 ——
   * 界面上必须说出来，否则看起来像数据丢了。
   */
  const { app } = await bootApp();
  const sourceNode = app['sourceNode'] as (s: unknown) => StubNode;

  const node = sourceNode({
    id: 's3',
    source_type: 'conversation',
    message_id: null,
    conversation_id: null,
    conversation_title: null,
    message_content: null,
    message_chars: null,
    message_created_at: null,
    created_at: '2026-10-09T04:23:20.518Z',
  });

  assert.match(textOf(node), /已删除/);
});

// ============================================================
// 视图切换
// ============================================================

test('showView 只激活对应的视图与导航项', async () => {
  const { dom, app } = await bootApp();
  const showView = app['showView'] as (n: string) => void;

  showView('memories');

  assert.equal(dom.view('memories').classList.contains('active'), true);
  assert.equal(dom.view('chat').classList.contains('active'), false);
  assert.equal(dom.nav('memories').classList.contains('active'), true);
  assert.equal(dom.nav('chat').classList.contains('active'), false);

  showView('graph');
  assert.equal(dom.view('graph').classList.contains('active'), true);
  assert.equal(dom.view('memories').classList.contains('active'), false);
});

test('未知视图名退回对话页，不留下空白界面', async () => {
  /**
   * 手敲 URL（#/不存在的页面）不该让用户看到一片空白 ——
   * 那看起来像系统坏了。
   */
  const { dom, app } = await bootApp();
  (app['showView'] as (n: string) => void)('这不是视图');
  assert.equal(dom.view('chat').classList.contains('active'), true);
});

// ============================================================
// 导航徽标
// ============================================================

test('待裁决数 > 0 时导航上出现徽标，为 0 时不出现', async () => {
  const { dom, app } = await bootApp();

  const shell = app['shell'] as { set: (p: unknown) => void };
  const renderNavBadge = app['renderNavBadge'] as () => void;

  shell.set({ overview: { current: 66, conflict: 23, superseded: 1, archived: 0, rejected: 0, deleted: 0, total: 90 } });
  renderNavBadge();
  const badge = dom.nav('memories').querySelector('.badge');
  assert.ok(badge, '有待裁决时应有徽标');
  /**
   * ⚠️ 用 text()（递归收集）而不是 textContent：
   *    徽标的文字是 h() 建出来的**子文本节点**，父节点的 textContent
   *    在真实 DOM 里会递归拼接，而桩只在叶子上存值。
   *    两种语义都对，只是桩没那么全 —— 断言用 text() 更贴近意图。
   */
  assert.equal(badge!.text(), '23');

  shell.set({ overview: { current: 90, conflict: 0, superseded: 0, archived: 0, rejected: 0, deleted: 0, total: 90 } });
  renderNavBadge();
  assert.equal(dom.nav('memories').querySelector('.badge'), null, '没有待裁决时不该留一个 0');
});

// ============================================================
// 守测试工具本身
// ============================================================

test('DOM 桩的行为与浏览器一致（否则上面的用例会假绿）', () => {
  /**
   * 这个用例守的是**测试工具**，不是产品代码。
   * 若哪天有人把 insertBefore 改成宽容处理，复现用例就会假绿 ——
   * 那比没有测试更危险。
   */
  const parent = new StubNode('div');
  const a = new StubNode('div');
  const b = new StubNode('div');
  const outsider = new StubNode('div');

  parent.appendChild(a);
  parent.appendChild(b);

  assert.throws(() => parent.insertBefore(outsider, new StubNode('div')), /is not a child of this node/);

  parent.insertBefore(outsider, null);
  assert.deepEqual(parent.childNodes, [a, b, outsider]);

  parent.insertBefore(outsider, b);
  assert.deepEqual(parent.childNodes, [a, outsider, b]);

  const other = new StubNode('div');
  other.appendChild(outsider);
  assert.ok(!parent.childNodes.includes(outsider), 'appendChild 应把节点从原父节点摘走');
});

test('DOM 桩的 querySelectorAll 能按类名与属性找（徽标用例依赖它）', () => {
  const root = new StubNode('body');
  const nav = new StubNode('a');
  nav.attrs.set('data-nav', 'memories');
  const badge = new StubNode('span');
  badge.className = 'badge';
  nav.appendChild(badge);
  root.appendChild(nav);

  const section = new StubNode('section');
  section.className = 'view active';
  root.appendChild(section);

  assert.equal(root.querySelectorAll('[data-nav]').length, 1);
  assert.equal(root.querySelectorAll('.badge').length, 1);
  assert.equal(root.querySelector('.badge'), badge);
  assert.equal(root.querySelectorAll('.view').length, 1);
  assert.equal(root.querySelectorAll('section').length, 1);
});

test('DOM 桩的 text() 递归收集子树文本（断言用）', () => {
  const root = new StubNode('div');
  const a = new StubNode('span');
  a.textContent = '你好';
  const b = new StubNode('span');
  b.textContent = '世界';
  root.appendChild(a);
  root.appendChild(b);

  assert.equal(root.text(), '你好 世界');
});

// ============================================================
// 手机端布局（2026-10-13，docs/18）
//
// 【这些测试能测什么、不能测什么】
//   能测：JS 那一半 —— 两栏切换的状态与类名、标题栏文字、
//         按钮点击后的行为、深链进来落在哪一栏。
//   不能测：CSS 那一半 —— 媒体查询在真实视口下的表现。
//          getComputedStyle 在这个桩环境里不存在，
//          「底部标签栏真的在屏幕底部」这种事只能靠真机/设备模拟确认。
//          所以这里守的是「点了会发生正确的事」，不是「看起来对」。
// ============================================================

test('手机首屏：#/chat 时显示会话列表（还没选会话，没有消息可看）', async () => {
  const { dom } = await bootApp({}, [], '#/chat');

  assert.ok(
    dom.chatLayout.className.includes('is-mobile-list'),
    '没选会话时应落在列表栏 —— 否则手机上首屏是一片空白'
  );
});

test('🔴 手机深链：#/chat/<id> 时直接显示消息，不停在列表', async () => {
  /**
   * 场景：手机上刷新页面、或从书签进来，URL 里带着会话 id。
   * 如果这时还停在列表栏，用户会以为「我明明点进来了怎么是列表」。
   */
  const { dom } = await bootApp(
    {
      'GET /conversations/c1': {
        id: 'c1',
        title: '深夜问候',
        messages: [{ id: 'm1', role: 'user', content: '晚上好', created_at: '2026-10-13T15:10:24.184Z' }],
      },
      'GET /conversations/c1/memories': { items: [] },
    },
    [],
    '#/chat/c1'
  );

  assert.ok(
    !dom.chatLayout.className.includes('is-mobile-list'),
    '#/chat/<id> 首帧就该显示消息栏，而不是等网络返回后才切'
  );
});

test('手机上选中会话后自动切到消息栏', async () => {
  const { dom, app } = await bootApp({
    'GET /conversations/c1': { id: 'c1', title: '深夜问候', messages: [] },
    'GET /conversations/c1/memories': { items: [] },
  });

  const openConversation = app['openConversation'] as (id: string) => Promise<void>;
  await openConversation('c1');

  assert.ok(
    !dom.chatLayout.className.includes('is-mobile-list'),
    '选中会话应当切到消息栏 —— 否则用户点了没反应'
  );
});

test('「新会话」把手机界面切回列表栏（新会话没有内容可看）', async () => {
  const { dom, app } = await bootApp({
    'GET /conversations/c1': { id: 'c1', title: '旧的', messages: [] },
    'GET /conversations/c1/memories': { items: [] },
  });

  await (app['openConversation'] as (id: string) => Promise<void>)('c1');
  assert.ok(!dom.chatLayout.className.includes('is-mobile-list'), '前置条件：先在消息栏');

  (app['newChat'] as () => void)();
  assert.ok(
    dom.chatLayout.className.includes('is-mobile-list'),
    '新会话应当回到列表栏 —— 否则用户面对一个空白输入框，不知道自己在哪'
  );
});

test('标题栏显示当前会话名，让用户知道自己在哪条会话里', async () => {
  const { dom, app } = await bootApp({
    'GET /conversations/c1': { id: 'c1', title: '深夜问候', messages: [] },
    'GET /conversations/c1/memories': { items: [] },
  });

  await (app['openConversation'] as (id: string) => Promise<void>)('c1');

  const title = dom.get('mobile-chat-title');
  assert.match(title.textContent ?? '', /深夜问候/, '手机标题栏要显示会话名');
});

test('手机两栏切换按钮：来回都能切，且类名同步', async () => {
  const { dom } = await bootApp({
    'GET /conversations/c1': { id: 'c1', title: '深夜问候', messages: [] },
    'GET /conversations/c1/memories': { items: [] },
  });

  // 从列表栏点「返回对话」→ 应在消息栏
  dom.get('btn-mobile-back-to-chat').onclick?.({});
  assert.ok(!dom.chatLayout.className.includes('is-mobile-list'), '点返回对话应切到消息栏');

  // 再点「历史会话」→ 应回列表栏
  dom.get('btn-mobile-conv-list').onclick?.({});
  assert.ok(dom.chatLayout.className.includes('is-mobile-list'), '点历史会话应切回列表栏');
});

test('桌面宽度不受影响：切换类名在，但桌面 CSS 不理会它', async () => {
  /**
   * ⚠️ 这条是**约定测试**，不是行为测试。
   *
   * 手机两栏切换靠 .chat-layout 上的 is-mobile-list 类，
   * 而那个类的所有效果都写在 @media (max-width: 640px) 里。
   * 也就是说桌面下这个类会一直存在、但没有任何视觉效果。
   *
   * 这条测试的作用是**把这个约定钉住**：如果将来有人把
   * .is-mobile-list 的规则挪出媒体查询（比如为了图省事），
   * 桌面上就会莫名其妙地少一栏 —— 而那是一种很难查的回归。
   * 这里读 app.css 原文来确认它仍在媒体查询块内。
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const css = readFileSync(join(process.cwd(), 'public', 'app.css'), 'utf8');

  const mobileBlockStart = css.lastIndexOf('@media (max-width: 640px)');
  assert.ok(mobileBlockStart > 0, '应当存在 640px 断点');

  const mobileBlock = css.slice(mobileBlockStart);
  assert.match(mobileBlock, /\.is-mobile-list/, 'is-mobile-list 的规则必须在 640px 断点内');

  // 反向确认：640px 断点之前不应出现这条选择器
  const beforeMobile = css.slice(0, mobileBlockStart);
  assert.doesNotMatch(
    beforeMobile,
    /\.is-mobile-list/,
    'is-mobile-list 不能在媒体查询之外 —— 那会让桌面版也少一栏'
  );
});
