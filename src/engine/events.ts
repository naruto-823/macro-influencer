/** 生产链路实时事件：引擎在各阶段发出，经 EventBus 广播给 SSE 前端。 */
export type PipelineEvent =
  | { type: 'run.start'; runId: string; persona: string; stages: string[] }
  | { type: 'stage.start'; skill: string; title: string; index: number }
  | { type: 'stage.progress'; skill: string; msg: string }
  | { type: 'stage.done'; skill: string; output: unknown }
  | { type: 'gate'; skill: string; question: string; choice: string }
  | { type: 'run.done'; runId: string; dir: string }
  | { type: 'run.failed'; skill?: string; error: string };

/** 极简事件总线：多个订阅者，同步广播。 */
export class EventBus {
  private readonly listeners = new Set<(e: PipelineEvent) => void>();

  /** 订阅，返回取消订阅函数。 */
  on(fn: (e: PipelineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 广播一个事件给当前所有订阅者。 */
  emit(e: PipelineEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** 当前订阅者数量。 */
  get size(): number {
    return this.listeners.size;
  }
}
