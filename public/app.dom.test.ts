/**
 * 前端 DOM 行为的回归测试（无需浏览器）
 *
 * 【它为什么存在】
 *   🔴 2026-09-26 实际事故：打开任意一个历史会话，界面显示
 *      「加载失败：Failed to execute 'insertBefore' on 'Node':
 *        The node before which the new node is to be inserted is not a child of this node.」
 *
 *   原因是 addMessage 里顺序写反了：先调 stampMessage（内部 insertBefore），
 *   后把消息节点挂进 DOM —— 而 insertBefore 的参照节点必须是父节点的子节点。
 *
 *   当时 **399 个 Node 测试全绿**，因为测试跑不到浏览器 DOM。
 *   这个文件补上那一层：用一个**忠实模拟浏览器语义**的最小 DOM
 *   （关键：参照节点不是子节点时必须抛错），把 app.js **真正执行**一遍。
 *
 * 【为什么不用 jsdom / happy-dom】
 *   本项目前端是零依赖、零构建的（docs/02 §6 的取舍）。
 *   为几个断言引入一个 DOM 实现，会让「pnpm i 之后能不能跑」多一个变量。
 *   这里只需要 DOM 的**契约**，不需要它的实现 —— 手写更可控，
 *   失败信息也是我们自己写的，更好读。
 *
 * 【局限（必须知道）】
 *   验证的是**逻辑与调用顺序**，不是渲染效果。
 *   CSS 对不对、布局好不好看，仍然只能在真实浏览器里看。
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
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  /** 记录被设置过的 innerHTML（markdown 渲染走这条路） */
  innerHTML = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
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

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  focus(): void {}

  /** 只支持 app.js 实际用到的选择器 */
  querySelector(sel: string): StubNode | null {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.childNodes.find((c) => c.classList.contains(cls)) ?? null;
    }
    return this.childNodes.find((c) => c.tagName === sel.toUpperCase()) ?? null;
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
}

const SELECTORS = [
  'health',
  'mem-list',
  'mem-search',
  'mem-view',
  'tl-list',
  'tl-category',
  'goal-list',
  'goal-form',
  'goal-title',
  'goal-desc',
  'goal-target',
  'btn-new-goal',
  'btn-cancel-goal',
  'review-box',
  'btn-review',
  'btn-send',
  'input',
  'conv-list',
  'chat-title',
  'chat-hint',
  'messages',
] as const;

interface Dom {
  root: StubNode;
  get: (sel: string) => StubNode;
}

function buildDom(): Dom {
  const root = new StubNode('body');
  const map = new Map<string, StubNode>();

  for (const id of SELECTORS) {
    const n = new StubNode('div');
    n.attrs.set('id', id);
    map.set(`#${id}`, n);
    root.appendChild(n);
  }
  for (const v of ['chat', 'memories', 'timeline', 'goals', 'review', 'settings']) {
    const n = new StubNode('section');
    n.attrs.set('id', `view-${v}`);
    map.set(`#view-${v}`, n);
    root.appendChild(n);
  }

  return {
    root,
    get: (sel: string): StubNode => {
      const found = map.get(sel);
      if (found) return found;
      /**
       * 未登记的选择器返回一个挂在 root 下的空节点，而不是 null ——
       * app.js 里大量 `$(...).addEventListener`，返回 null 会炸在无关的地方，
       * 让真正的失败被掩盖。给它一个真节点，缺什么就少什么。
       */
      const fresh = new StubNode('div');
      map.set(sel, fresh);
      root.appendChild(fresh);
      return fresh;
    },
  };
}

// ============================================================
// 把 app.js 真正跑起来
// ============================================================

type TestHooks = {
  addMessage: (role: string, text: string, opts?: Record<string, unknown>) => StubNode;
  openConversation: (id: string) => Promise<void>;
};

/** app.js 的模块级状态会残留，因此每个用例全新 import */
async function bootApp(
  routes: Record<string, unknown> = {}
): Promise<{ dom: Dom; hooks: TestHooks }> {
  const dom = buildDom();

  (globalThis as Record<string, unknown>)['document'] = {
    querySelector: (sel: string) => dom.get(sel),
    querySelectorAll: () => [],
    createElement: (tag: string) => new StubNode(tag),
  };
  (globalThis as Record<string, unknown>)['location'] = { hash: '#/chat' };
  (globalThis as Record<string, unknown>)['window'] = {
    addEventListener: () => {},
  };
  (globalThis as Record<string, unknown>)['alert'] = () => {};
  (globalThis as Record<string, unknown>)['confirm'] = () => true;

  (globalThis as Record<string, unknown>)['fetch'] = async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace('/api/v1', '')}`;
    const hit = routes[key];

    // 未登记的一律返回空成功响应：app.js 启动时会并发打好几个接口
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: hit ?? {} }),
      json: async () => ({ success: true, data: hit ?? {} }),
    } as unknown as Response;
  };

  await import(`./app.js?fresh=${Math.random()}`);

  const hooks = (globalThis as unknown as { window: { __lifemateTestHooks: TestHooks } }).window
    .__lifemateTestHooks;

  assert.ok(hooks, 'app.js 应挂出测试入口 __lifemateTestHooks');

  return { dom, hooks };
}

// ============================================================
// 用例
// ============================================================

test('🔴 回归：第一条历史消息之前必须有日期分隔条，且不抛 insertBefore 错误', async () => {
  /**
   * 这是那次事故的复现，断言分两层 —— **两层缺一不可**：
   *
   *   ① 不抛错（浏览器里的表现是整页「加载失败」）
   *   ② 分隔条**真的插进去了**
   *
   * ⚠️ 只断言 ① 会让这个测试变成假的。实测过：
   *    修复时顺手在 stampMessage 里加了一句
   *    `if (wrap.parentNode !== box) return;` 作为防御，
   *    于是顺序写错时它**静默 return**、什么也不插 ——
   *    异常没了，但分隔条也没了（而且失败得毫无提示）。
   *    只断言「不抛错」的版本在故意写坏顺序后**依然全绿**，
   *    等于没测。断言 ② 才抓得住。
   */
  const { dom, hooks } = await bootApp();

  assert.doesNotThrow(() => {
    hooks.addMessage('user', '第一条', { createdAt: '2026-09-24T00:51:00Z' });
  }, 'addMessage 必须先挂节点再插分隔条');

  assert.doesNotThrow(() => {
    hooks.addMessage('assistant', '第二条', { createdAt: '2026-09-24T00:51:00Z' });
  });

  const box = dom.get('#messages');

  /**
   * ⚠️ 断言**位置与数量**，不断言日期标签的具体文字。
   *    dayLabel 的输出依赖「今天」是几号 —— 那是运行时的真实时钟。
   *    把「今天」写进期望值会让这个测试在换一天之后失败，
   *    而它想守的其实只是「分隔条在消息之前、且只出现一次」。
   */
  assert.equal(box.childNodes.length, 3, '一条分隔条 + 两条消息（同一轮的一问一答）');
  assert.equal(box.childNodes[0]!.classList.contains('day-divider'), true, '分隔条在消息之前');
  assert.equal(box.childNodes[1]!.classList.contains('msg'), true);

  assert.equal(box.childrenWithClass('day-divider').length, 1, '同一时刻的第二条不再插分隔条');
  assert.equal(box.childrenWithClass('msg').length, 2);

  // 两条消息上的时间都应写出来（时间格式是固定的，可以断言）
  const metas = box.childrenWithClass('msg').map((m) => m.querySelector('.msg-meta')?.textContent);
  assert.deepEqual(metas, ['09-24 08:51', '09-24 08:51']);
});

test('同一轮的一问一答之间不会插分隔条（created_at 相同）', async () => {
  const { dom, hooks } = await bootApp();

  // 同一个事务写入 → now() 是常量 → 两条 created_at 完全相同
  const t = '2026-09-26T12:18:00Z';
  hooks.addMessage('user', '问题', { createdAt: t });
  hooks.addMessage('assistant', '回答', { createdAt: t });

  assert.equal(dom.get('#messages').childrenWithClass('day-divider').length, 1);
  assert.equal(dom.get('#messages').childrenWithClass('msg').length, 2);
});

test('跨天的历史消息各插一条分隔条，且顺序正确', async () => {
  const { dom, hooks } = await bootApp();

  hooks.addMessage('user', '第一天', { createdAt: '2026-09-24T00:51:00Z' });
  hooks.addMessage('assistant', '第一天答', { createdAt: '2026-09-24T00:51:00Z' });
  hooks.addMessage('user', '第三天', { createdAt: '2026-09-26T08:00:00Z' });

  const box = dom.get('#messages');
  assert.equal(box.childrenWithClass('day-divider').length, 2, '跨了两天，应有两条分隔条');
  assert.equal(box.childrenWithClass('msg').length, 3);

  /**
   * 顺序断言：分隔条必须紧邻它要标的**那一条消息之前**。
   * 用「每条 msg 之前要么是 day-divider，要么是另一条 msg」来验证，
   * 并额外确认第一条消息之前一定有一条 —— 否则模型与用户都会失锚。
   */
  const seq = box.childNodes.map((c) =>
    c.classList.contains('day-divider') ? 'D' : c.classList.contains('msg') ? 'M' : '?'
  );
  assert.deepEqual(seq, ['D', 'M', 'M', 'D', 'M'], '结构应为 分隔条-消息-消息-分隔条-消息');

  // 具体的时刻仍然可断言（与日期标签不同，它是固定的）
  const metas = box.childrenWithClass('msg').map((m) => m.querySelector('.msg-meta')?.textContent);
  assert.deepEqual(metas, ['09-24 08:51', '09-24 08:51', '09-26 16:00']);
});

test('没有 createdAt 时不显示时间也不插分隔条（不假装是现在）', async () => {
  const { dom, hooks } = await bootApp();

  hooks.addMessage('user', '没有时间的消息');

  const box = dom.get('#messages');
  assert.equal(box.childrenWithClass('day-divider').length, 0);
  const meta = box.childrenWithClass('msg')[0]!.querySelector('.msg-meta');
  assert.equal(meta?.textContent, '');
});

test('非法时间字符串被忽略，不抛错也不写坏时间', async () => {
  const { dom, hooks } = await bootApp();

  assert.doesNotThrow(() => {
    hooks.addMessage('user', '时间坏了', { createdAt: '不是时间' });
  });

  assert.equal(dom.get('#messages').childrenWithClass('day-divider').length, 0);
});

test('🔴 回归：openConversation 渲染历史时，分隔条真的插进去了', async () => {
  /**
   * 端到端的那条路径 —— 用户在界面上点一个历史会话。
   *
   * ⚠️ 这里同样**不能只断言「没抛错」**（理由见上一条）。
   *    那次事故在浏览器里表现为「加载失败」，但一旦 stampMessage
   *    多了防御性 return，同样的顺序错误就退化成「静默不插分隔条」——
   *    用户看到的是「时间没了」，一样是坏结果，却没有任何报错。
   *    因此断言必须落在**渲染结果**上。
   */
  const { dom, hooks } = await bootApp({
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
  });

  await assert.doesNotReject(() => hooks.openConversation('c1'));

  const box = dom.get('#messages');
  const text = box.outline().join(' ');
  assert.doesNotMatch(text, /加载失败/, '不该出现加载失败提示');

  assert.equal(box.childrenWithClass('msg').length, 3, '三条消息都应渲染出来');
  assert.equal(box.childrenWithClass('day-divider').length, 2, '跨天两处各一条分隔条');

  // 结构：分隔条-消息-消息-分隔条-消息；第一条消息之前必须有分隔条（否则失锚）
  assert.deepEqual(
    box.childNodes.map((c) =>
      c.classList.contains('day-divider') ? 'D' : c.classList.contains('msg') ? 'M' : '?'
    ),
    ['D', 'M', 'M', 'D', 'M']
  );

  // 每条消息都带上了时间
  const metas = box.childrenWithClass('msg').map((m) => m.querySelector('.msg-meta')?.textContent);
  assert.deepEqual(metas, ['09-24 08:51', '09-24 08:51', '09-26 16:00']);

  assert.equal(dom.get('#chat-title').textContent, '测试会话');
});

test('已删除的会话：消息为空时显示删除提示而不是空列表', async () => {
  const { dom, hooks } = await bootApp({
    'GET /conversations/c2': {
      id: 'c2',
      title: '[已删除的对话]',
      status: 'deleted',
      messages: [],
    },
  });

  await hooks.openConversation('c2');
  assert.match(dom.get('#messages').outline().join(' '), /已被删除/);
});

test('openConversation 的 HTTP 失败被捕获成提示，不抛到调用方', async () => {
  /**
   * 「加载失败：…」这条路必须存在且不炸 —— 用户看到的应该是一句话，
   * 而不是一片空白。那次事故里用户看到的就是它（只是内容不该是 DOM 异常）。
   */
  const { dom, hooks } = await bootApp();

  (globalThis as Record<string, unknown>)['fetch'] = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ error: { message: '服务内部错误' } }),
    json: async () => ({ error: { message: '服务内部错误' } }),
  } as unknown as Response);

  await assert.doesNotReject(() => hooks.openConversation('c3'));
  assert.match(dom.get('#messages').outline().join(' '), /加载失败/);
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

  // 参照节点不是子节点 → 必须抛（浏览器的真实行为）
  assert.throws(
    () => parent.insertBefore(outsider, new StubNode('div')),
    /is not a child of this node/
  );

  // refNode 为 null → append，不报错
  parent.insertBefore(outsider, null);
  assert.deepEqual(parent.childNodes, [a, b, outsider]);

  // 插到中间
  parent.insertBefore(outsider, b);
  assert.deepEqual(parent.childNodes, [a, outsider, b]);

  // appendChild 会把节点从原父节点摘走（浏览器语义）
  const other = new StubNode('div');
  other.appendChild(outsider);
  assert.ok(!parent.childNodes.includes(outsider), 'appendChild 应把节点从原父节点摘走');
});
