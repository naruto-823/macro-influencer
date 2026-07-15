import { withTrace } from '../llm/trace.js';
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
  /** 失败后静默自动重试次数（吞掉瞬时超时/限流），用尽后才惊动人工。默认 0。 */
  autoRetries?: number;
  /**
   * 可选：某阶段（含自动重试）仍失败时的交互处理。
   * 返回 'retry' 重跑该阶段（复用已跑好的前序结果）、'skip' 跳过、'abort' 中止整条 run。
   * 不传则失败即中止（旧行为）。
   */
  onStageFailed?: (info: {
    skill: string;
    title: string;
    error: string;
    attempt: number;
  }) => Promise<'retry' | 'skip' | 'abort'>;
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
    // wallclock 只算「计算时间」：人工卡点/失败决策的等待时间不该计入，否则你在卡点上想久了就把 run 耗超时。
    let deadline = Date.now() + this.cfg.runWallclockMs;
    const offClock = async <T>(p: Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try {
        return await p;
      } finally {
        deadline += Date.now() - t0;
      }
    };

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
      const autoRetries = this.cfg.autoRetries ?? 0;
      // 失败重试循环：先静默自动重试，用尽后交人工（重试/跳过/中止），重试复用已跑好的前序 bag。
      let attempt = 0;
      let skipped = false;
      while (true) {
        attempt++;
        try {
          bag[skill.name] = await withTrace({ runId, skill: skill.name }, () =>
            withTimeout(skill.run(ctx), stage.timeoutMs ?? this.cfg.skillTimeoutMs, skill.title),
          );
          break;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (attempt <= autoRetries) {
            ctx.emit(`⚠ ${skill.title} 失败，自动重试 ${attempt}/${autoRetries}：${error}`);
            onEvent?.({ type: 'stage.start', skill: skill.name, title: skill.title, index: i });
            continue;
          }
          if (this.cfg.onStageFailed) {
            onEvent?.({
              type: 'stage.failed',
              skill: skill.name,
              title: skill.title,
              error,
              attempt,
            });
            const decision = await offClock(
              this.cfg.onStageFailed({
                skill: skill.name,
                title: skill.title,
                error,
                attempt,
              }),
            );
            onEvent?.({ type: 'stage.retry', skill: skill.name, choice: decision });
            if (decision === 'retry') {
              ctx.emit(`↻ 重试 ${skill.title}`);
              onEvent?.({ type: 'stage.start', skill: skill.name, title: skill.title, index: i });
              continue;
            }
            if (decision === 'skip') {
              ctx.emit(`⏭ 跳过 ${skill.title}（失败后人工跳过）`);
              skipped = true;
              break;
            }
          }
          onEvent?.({ type: 'run.failed', skill: skill.name, error });
          throw err;
        }
      }
      if (skipped) continue;
      onEvent?.({ type: 'stage.done', skill: skill.name, output: bag[skill.name] });

      if (stage.gateAfter) {
        const opts =
          typeof stage.gateAfter.options === 'function'
            ? stage.gateAfter.options(bag)
            : stage.gateAfter.options;
        onEvent?.({
          type: 'gate.waiting',
          skill: skill.name,
          question: stage.gateAfter.question,
          options: opts,
        });
        const choice = await offClock(this.cfg.gate(stage.gateAfter.question, opts));
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
