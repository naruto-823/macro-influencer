import { describe, expect, it, vi } from 'vitest';
import type { PipelineEvent } from './events.js';
import { SkillRegistry } from './registry.js';
import type { Skill, SkillContext, Stage } from './types.js';
import { WorkflowEngine } from './workflow.js';

function ctxBase(): Omit<SkillContext, 'bag'> {
  return {
    runId: 'r1',
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩，引擎不触碰这些字段
    llm: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    persona: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    sources: {} as any,
    emit: () => {},
    signal: new AbortController().signal,
  };
}

function skill(name: string, run: Skill['run']): Skill {
  return { name, title: name, run };
}

describe('WorkflowEngine', () => {
  it('顺序跑各 Skill，并把返回值写入 bag[name]', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', async () => 1));
    reg.register(skill('b', async (ctx) => (ctx.bag.a as number) + 1));
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
    });
    const bag = await eng.run('r1', [{ skillName: 'a' }, { skillName: 'b' }], ctxBase());
    expect(bag.a).toBe(1);
    expect(bag.b).toBe(2);
  });

  it('onEvent 按序发出 run.start / stage.start / stage.done / run.failed', async () => {
    const reg = new SkillRegistry();
    reg.register(
      skill('a', async (ctx) => {
        ctx.emit('干活中');
        return 1;
      }),
    );
    reg.register(
      skill('boom', async () => {
        throw new Error('炸了');
      }),
    );
    const events: PipelineEvent[] = [];
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
      onEvent: (e) => events.push(e),
    });
    await expect(
      eng.run('r9', [{ skillName: 'a' }, { skillName: 'boom' }], ctxBase()),
    ).rejects.toThrow(/炸了/);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.start');
    expect(types).toContain('stage.start');
    expect(types).toContain('stage.progress');
    expect(types).toContain('stage.done');
    expect(types).toContain('run.failed');
    // a 先 done，boom 再 failed
    expect(types.indexOf('stage.done')).toBeLessThan(types.indexOf('run.failed'));
  });

  it('gateAfter 调用 gate 并把选择写入 bag[gate.<skill>]', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', async () => ['x', 'y']));
    const gate = vi.fn(async () => 'y');
    const eng = new WorkflowEngine(reg, { skillTimeoutMs: 1000, runWallclockMs: 5000, gate });
    const stages: Stage[] = [
      { skillName: 'a', gateAfter: { question: '选?', options: (bag) => bag.a as string[] } },
    ];
    const bag = await eng.run('r1', stages, ctxBase());
    expect(gate).toHaveBeenCalledWith('选?', ['x', 'y']);
    expect(bag['gate.a']).toBe('y');
  });

  it('haltOn 命中则中止后续 Skill', async () => {
    const reg = new SkillRegistry();
    const bRun = vi.fn(async () => 2);
    reg.register(skill('a', async () => 1));
    reg.register(skill('b', bRun));
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '打回',
    });
    const stages: Stage[] = [
      { skillName: 'a', gateAfter: { question: '?', options: ['通过', '打回'], haltOn: ['打回'] } },
      { skillName: 'b' },
    ];
    await eng.run('r1', stages, ctxBase());
    expect(bRun).not.toHaveBeenCalled();
  });

  it('Skill 超时则抛错', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('slow', () => new Promise((r) => setTimeout(() => r(1), 50))));
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 10,
      runWallclockMs: 5000,
      gate: async () => '',
    });
    await expect(eng.run('r1', [{ skillName: 'slow' }], ctxBase())).rejects.toThrow(/超时|timeout/);
  });
});
