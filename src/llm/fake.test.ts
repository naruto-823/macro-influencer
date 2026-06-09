import { describe, expect, it } from 'vitest';
import { FakeLlmClient } from './fake.js';

describe('FakeLlmClient', () => {
  it('complete 按顺序吐预置回复', async () => {
    const llm = new FakeLlmClient(['一', '二']);
    expect(await llm.complete({ prompt: 'x' })).toBe('一');
    expect(await llm.complete({ prompt: 'y' })).toBe('二');
  });

  it('completeJson 解析 JSON 回复', async () => {
    const llm = new FakeLlmClient(['{"a":1}']);
    expect(await llm.completeJson<{ a: number }>({ prompt: 'x' })).toEqual({ a: 1 });
  });

  it('记录收到的 prompt', async () => {
    const llm = new FakeLlmClient(['ok']);
    await llm.complete({ system: 's', prompt: 'hello' });
    expect(llm.calls[0]?.prompt).toBe('hello');
    expect(llm.calls[0]?.system).toBe('s');
  });
});
