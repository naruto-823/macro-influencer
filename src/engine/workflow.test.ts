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
    judge: {} as any,
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

  it('autoRetries：失败后静默自动重试，成功则继续', async () => {
    const reg = new SkillRegistry();
    let tries = 0;
    reg.register(
      skill('flaky', async () => {
        tries++;
        if (tries < 2) throw new Error('瞬时炸');
        return 'ok';
      }),
    );
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
      autoRetries: 1,
    });
    const bag = await eng.run('r1', [{ skillName: 'flaky' }], ctxBase());
    expect(tries).toBe(2);
    expect(bag.flaky).toBe('ok');
  });

  it('阶段可覆盖全局 autoRetries，长耗时节点失败时不整段重跑', async () => {
    const reg = new SkillRegistry();
    let tries = 0;
    reg.register(
      skill('expensive', async () => {
        tries++;
        throw new Error('失败');
      }),
    );
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
      autoRetries: 1,
    });
    await expect(
      eng.run('r1', [{ skillName: 'expensive', autoRetries: 0 }], ctxBase()),
    ).rejects.toThrow('失败');
    expect(tries).toBe(1);
  });

  it('onStageFailed=retry：用尽自动重试后人工重试，复用前序 bag', async () => {
    const reg = new SkillRegistry();
    let tries = 0;
    reg.register(skill('pre', async () => 'kept'));
    reg.register(
      skill('boom', async (ctx) => {
        tries++;
        // 第一次失败，重试时能看到前序 pre 的结果还在
        if (tries < 2) throw new Error('炸');
        return ctx.bag.pre;
      }),
    );
    const decisions: string[] = [];
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
      onStageFailed: async (info) => {
        decisions.push(info.skill);
        return 'retry';
      },
    });
    const bag = await eng.run('r1', [{ skillName: 'pre' }, { skillName: 'boom' }], ctxBase());
    expect(decisions).toEqual(['boom']);
    expect(bag.boom).toBe('kept'); // 重试复用了前序 pre 结果
  });

  it('onStageFailed=skip：跳过失败节点，后续继续', async () => {
    const reg = new SkillRegistry();
    reg.register(
      skill('boom', async () => {
        throw new Error('炸');
      }),
    );
    const after = vi.fn(async () => 'done');
    reg.register(skill('after', after));
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
      onStageFailed: async () => 'skip',
    });
    const bag = await eng.run('r1', [{ skillName: 'boom' }, { skillName: 'after' }], ctxBase());
    expect(bag.boom).toBeUndefined();
    expect(after).toHaveBeenCalled();
    expect(bag.after).toBe('done');
  });

  it('onStageFailed=abort：中止整条 run', async () => {
    const reg = new SkillRegistry();
    reg.register(
      skill('boom', async () => {
        throw new Error('炸');
      }),
    );
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 1000,
      runWallclockMs: 5000,
      gate: async () => '',
      onStageFailed: async () => 'abort',
    });
    await expect(eng.run('r1', [{ skillName: 'boom' }], ctxBase())).rejects.toThrow(/炸/);
  });

  it('人工卡点的等待时间不计入 run wallclock 超时', async () => {
    const reg = new SkillRegistry();
    reg.register(skill('a', async () => 1));
    reg.register(skill('b', async () => 2));
    // wallclock 仅 100ms，但卡点等待 200ms（>wallclock）；扣掉等待时间后 run 仍应跑完。
    const eng = new WorkflowEngine(reg, {
      skillTimeoutMs: 2000,
      runWallclockMs: 100,
      gate: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'x';
      },
    });
    const stages: Stage[] = [
      { skillName: 'a', gateAfter: { question: '?', options: ['x'] } },
      { skillName: 'b' },
    ];
    const bag = await eng.run('r', stages, ctxBase());
    expect(bag.b).toBe(2);
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
