import { type LlmClient, type LlmCompleteOpts, parseJson } from './client.js';

/** 测试用：按构造顺序吐预置回复，并记录所有调用。 */
export class FakeLlmClient implements LlmClient {
  readonly calls: LlmCompleteOpts[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}

  async complete(opts: LlmCompleteOpts): Promise<string> {
    this.calls.push(opts);
    const r = this.replies[this.i++];
    if (r === undefined) throw new Error(`FakeLlmClient 回复用尽（第 ${this.i} 次调用）`);
    return r;
  }

  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    return parseJson<T>(await this.complete(opts));
  }
}
