import type { SkillRegistry } from './registry.js';
import type { SkillContext, Stage } from './types.js';

export interface EngineConfig {
  skillTimeoutMs: number;
  runWallclockMs: number;
  /** 人工卡点交互：给出问题与选项，返回用户选择。 */
  gate: (question: string, options: string[]) => Promise<string>;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class WorkflowEngine {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly cfg: EngineConfig,
  ) {}

  /** 跑完整条流水线，返回最终 bag。 */
  async run(
    _runId: string,
    stages: Stage[],
    ctxBase: Omit<SkillContext, 'bag'>,
  ): Promise<Record<string, unknown>> {
    const bag: Record<string, unknown> = {};
    const ctx: SkillContext = { ...ctxBase, bag };
    const deadline = Date.now() + this.cfg.runWallclockMs;

    for (const stage of stages) {
      if (Date.now() > deadline) throw new Error('run 整体超时');
      const skill = this.registry.get(stage.skillName);
      ctx.emit(`▶ ${skill.title}`);
      bag[skill.name] = await withTimeout(skill.run(ctx), this.cfg.skillTimeoutMs, skill.title);

      if (stage.gateAfter) {
        const opts =
          typeof stage.gateAfter.options === 'function'
            ? stage.gateAfter.options(bag)
            : stage.gateAfter.options;
        const choice = await this.cfg.gate(stage.gateAfter.question, opts);
        bag[`gate.${skill.name}`] = choice;
        if (stage.gateAfter.haltOn?.includes(choice)) {
          ctx.emit(`⏹ 在「${skill.title}」后中止（选择：${choice}）`);
          return bag;
        }
      }
    }
    return bag;
  }
}
