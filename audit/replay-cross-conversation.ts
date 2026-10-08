/**
 * 跨会话衔接的真实效果验证（docs/15）
 *
 * 【为什么必须真跑一次】
 *   「注入了正确的上下文」与「模型用上了它」是两件事。
 *   机制测试只能证明前者。本次要回答的是后者 ——
 *   用户报的原始症状是模型**连续三次坚称没聊过**，
 *   那是个行为问题，只能用真实模型验证。
 *
 * 【怎么复刻那次失败】
 *   用用户真实的两个会话：
 *     会话 A「国庆后返工聊 agent 进度」10:01–10:14（末尾 6 条原样搬进来）
 *     会话 B 的开场白「我国庆节期间除了做项目之外，就是睡觉了……」
 *   改之前：模型在 B 的开场就问「你说的项目是哪个」，
 *          被指出后编理由、改口、反问用户。
 *   改之后：应当认出「项目」= 刚聊过的问卷系统，且不再否认聊过。
 *
 * 【安全】
 *   只写测试库（有 assertTestDatabase 守卫），跑完删除自己造的数据。
 *   用户的开发库一个字节都不碰。
 *
 * 运行：npx tsx --env-file=.env.test audit/replay-cross-conversation.ts
 */
import { eq, inArray } from 'drizzle-orm';

import { db, closePool } from '../src/database/client.js';
import { conversations } from '../src/database/schema/conversations.js';
import { messages } from '../src/database/schema/messages.js';
import { assertTestDatabase } from '../src/shared/test-guard.js';
import { resolveTestUser } from '../src/database/repository/_test-helpers.js';
import { chat } from '../src/conversation/chat-service.js';

assertTestDatabase('replay-cross-conversation');

/** 会话 A 的末尾 6 条（用户真实对话，10:12–10:14） */
const PREV_TAIL: { role: 'user' | 'assistant'; content: string; at: string }[] = [
  {
    role: 'user',
    at: '2026-10-08T10:12:00+08:00',
    content:
      '有道理，等我把初版弄完之后，看看能不能正常对话生成和改动问卷，等把这个功能做好之后再改你讲的这个总体的状态约束这些复杂的细节',
  },
  {
    role: 'assistant',
    at: '2026-10-08T10:12:30+08:00',
    content:
      '嗯，这个顺序对。约束字段本身不复杂，但它得等你真的看见模型改问卷时怎么跑偏，才知道该往里写什么——现在凭空设计反而是猜。\n\n那初版现在卡在哪？是刚才说的半成品草稿这块，还是别的地方？',
  },
  {
    role: 'user',
    at: '2026-10-08T10:14:00+08:00',
    content:
      '现在初版已经差不多了，把前端页面设计一下，连上模型的API就可以测试了，等我今天晚上下班回去之后测试一下就可以了',
  },
  {
    role: 'assistant',
    at: '2026-10-08T10:14:30+08:00',
    content:
      '那差不多了，前端页面这步通常比想的花时间——不是难，是琐碎。晚上测的时候真跑起来，模型那边肯定还会冒出些在单测里看不到的东西，尤其是工具定义那块，实际调用时的参数格式和你预期不一致很正常。\n\n测完有啥结果跟我说说。',
  },
];

/** 会话 B 的开场白（用户真实原话，10:15） */
const B_OPENER =
  '我国庆节期间除了做项目之外，就是睡觉了，最后两天把屋子里面打扫了一下，被子啥的都洗了一下，感觉整个人都精神了很多';

/** 第二步：复刻用户当时的追问（10:17） */
const B_FOLLOWUP = '你不记得了吗？我刚才跟你讲的我那个问卷系统呀';

async function main(): Promise<void> {
  const user = await resolveTestUser('replay-cross-conversation');
  const now = new Date();

  // ---------- 造会话 A：末尾消息落在 1 分钟前 ----------
  const aRows = await db
    .insert(conversations)
    .values({ userId: user.id, title: '【重放】国庆后返工聊 agent 进度', status: 'active' })
    .returning({ id: conversations.id });
  const convA = aRows[0]!.id;

  const lastOffsetMs = 1 * 60_000;
  for (let i = 0; i < PREV_TAIL.length; i++) {
    const item = PREV_TAIL[i]!;
    const backMs = lastOffsetMs + (PREV_TAIL.length - 1 - i) * 60_000;
    await db.insert(messages).values({
      conversationId: convA,
      role: item.role,
      content: item.content,
      sequence: i + 1,
      createdAt: new Date(now.getTime() - backMs),
    });
  }

  console.log('═'.repeat(76));
  console.log('会话 A 已铺好（末尾 2 条距现在约 1 分钟）');
  console.log('═'.repeat(76));

  // ---------- 发会话 B 第一句 ----------
  console.log(`\n【B 第一句】${B_OPENER}\n`);

  const result = await chat({ message: B_OPENER });
  const convB = result.conversation.id;

  console.log('─'.repeat(76));
  console.log(result.assistantMessage.content);
  console.log('─'.repeat(76));

  // ---------- 判定 ----------
  const reply1 = result.assistantMessage.content;
  const askedWhichProject = /哪个项目|什么项目|是.*还是.*工作上|没细讲|没说过|不记得/.test(reply1);
  const usedContext = /问卷/.test(reply1);

  console.log('\n══ 判定 ══');
  console.log(`第一轮是否用上了上一个会话的内容（提到「问卷」）：${usedContext ? '✅ 是' : '❌ 否'}`);
  console.log(`第一轮是否还在问「是哪个项目」/否认聊过：${askedWhichProject ? '❌ 是（问题仍在）' : '✅ 否'}`);

  // ---------- 第二轮：复刻用户的追问 ----------
  console.log(`\n【B 第二句】${B_FOLLOWUP}\n`);
  const result2 = await chat({ conversationId: convB, message: B_FOLLOWUP });
  console.log('─'.repeat(76));
  console.log(result2.assistantMessage.content);
  console.log('─'.repeat(76));

  const denied = /没细讲|没跟我说|不是在咱们这儿|你再说说|我看不到/.test(
    result2.assistantMessage.content
  );
  console.log('\n══ 判定 ══');
  console.log(`第二轮是否仍在否认/推诿：${denied ? '❌ 是（问题仍在）' : '✅ 否'}`);

  // ---------- 清理自己造的数据 ----------
  await db.delete(messages).where(inArray(messages.conversationId, [convA, convB]));
  await db.delete(conversations).where(inArray(conversations.id, [convA, convB]));
  console.log('\n已清理本次重放数据（两个会话及其消息）。');
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('\n重放失败：', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
