/**
 * Repository 层共享类型
 *
 * 单独成文件的原因：这些类型被多个仓库模块共用，
 * 若各自定义会出现同名但不同源的类型，`export *` 时直接冲突
 * （实测踩到：memory-store 与 extraction-runs 各定义了一份 ExecutorOption）。
 */
import type { db } from '../client.js';

/**
 * 事务内外通用的执行器类型。
 *
 * 为什么带上 transaction：Drizzle 的事务对象自身也有 .transaction()
 * （在已有事务内会生成 SAVEPOINT），因此仓库方法既能在事务外开新事务，
 * 也能被调用方传入一个外层事务，从而组合成更大的原子操作，
 * 或在测试里整体回滚。
 *
 * 显式定义并导出（而非让调用方用条件类型推导）：推导版本既脆弱又难读，
 * 实测会推出 never、把类型检查变成假通过。
 */
export type StoreExecutor = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'transaction'
>;

/** 所有仓库操作都接受可选的执行器，默认使用全局 db */
export interface ExecutorOption {
  /** 传入外层事务以组合原子操作；不传则在自身事务内执行 */
  executor?: StoreExecutor;
}
