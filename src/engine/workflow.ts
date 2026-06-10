import type { PipelineEvent } from './events.js';
import type { SkillRegistry } from './registry.js';
import type { SkillContext, Stage } from './types.js';

export interface EngineConfig {
  skillTimeoutMs: number;
  runWallclockMs: number;
  /** 人工卡点交互：给出问题与选项，返回用户选择。 */
  gate: (question: string, options: string[]) => Promise<string>;
  /** 可选：结构化事件回调（用于实时可视化）。不传则只走 ctx.emit 文本日志。 */
  onEvent?: (e: PipelineEvent) => void;
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
    runId: string,
    stages: Stage[],
    ctxBase: Omit<SkillContext, 'bag'>,
  ): Promise<Record<string, unknown>> {
    const bag: Record<string, unknown> = {};
    const onEvent = this.cfg.onEvent;
    // 包裹 emit：skill 内部的文本进度同时转成 stage.progress 结构化事件。
    let currentSkill = '';
    const baseEmit = ctxBase.emit;
    const ctx: SkillContext = {
      ...ctxBase,
      bag,
      emit: (msg) => {
        baseEmit(msg);
        if (currentSkill) onEvent?.({ type: 'stage.progress', skill: currentSkill, msg });
      },
    };
    const deadline = Date.now() + this.cfg.runWallclockMs;

    onEvent?.({
      type: 'run.start',
      runId,
      persona: ctxBase.persona?.displayName ?? '',
      stages: stages.map((s) => s.skillName),
    });

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!stage) continue;
      if (Date.now() > deadline) throw new Error('run 整体超时');
      const skill = this.registry.get(stage.skillName);
      currentSkill = skill.name;
      onEvent?.({ type: 'stage.start', skill: skill.name, title: skill.title, index: i });
      ctx.emit(`▶ ${skill.title}`);
      try {
        bag[skill.name] = await withTimeout(skill.run(ctx), this.cfg.skillTimeoutMs, skill.title);
      } catch (err) {
        onEvent?.({
          type: 'run.failed',
          skill: skill.name,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      onEvent?.({ type: 'stage.done', skill: skill.name, output: bag[skill.name] });

      if (stage.gateAfter) {
        const opts =
          typeof stage.gateAfter.options === 'function'
            ? stage.gateAfter.options(bag)
            : stage.gateAfter.options;
        const choice = await this.cfg.gate(stage.gateAfter.question, opts);
        bag[`gate.${skill.name}`] = choice;
        onEvent?.({ type: 'gate', skill: skill.name, question: stage.gateAfter.question, choice });
        if (stage.gateAfter.haltOn?.includes(choice)) {
          ctx.emit(`⏹ 在「${skill.title}」后中止（选择：${choice}）`);
          return bag;
        }
      }
    }
    return bag;
  }
}
