import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { PostgresStore } from '@mastra/pg';
import { z } from 'zod';
import { makeJudge, makeLlm } from '../cli.js';
import type { PipelineEvent } from '../engine/events.js';
import type { SkillContext } from '../engine/types.js';
import { persistRun } from '../output/persist.js';
import { buildRegistry } from '../run.js';
import { CachedHotspotSource } from '../sources/cached-hotspot.js';
import { MultiHotspotSource } from '../sources/web-hotspot.js';
import { WeiboHotspotSource } from '../sources/weibo-hotspot.js';
import { getAccount } from '../viz/account-store.js';

const RUNS_DIR = 'runs';
const pipelineDataSchema = z.object({
  runId: z.string(),
  userId: z.string(),
  personaId: z.string(),
  bag: z.record(z.string(), z.unknown()),
});
type PipelineData = z.infer<typeof pipelineDataSchema>;

const eventSinks = new Map<string, (event: PipelineEvent) => void>();
function emit(runId: string, event: PipelineEvent): void {
  eventSinks.get(runId)?.(event);
}

async function runSkill(
  skillName: string,
  data: PipelineData,
  timeoutMs: number,
): Promise<PipelineData> {
  const skill = buildRegistry().get(skillName);
  emit(data.runId, { type: 'stage.start', skill: skill.name, title: skill.title, index: -1 });
  const persona = await getAccount(data.userId, data.personaId);
  if (!persona) throw new Error('账号不存在或不属于当前用户');
  const writer = makeLlm();
  const ctx: SkillContext = {
    runId: data.runId,
    llm: writer,
    judge: makeJudge(writer),
    persona,
    sources: {
      hotspot: new CachedHotspotSource(
        new MultiHotspotSource({ extraSources: [new WeiboHotspotSource()] }),
        { ttlMs: 7_200_000, file: 'cache/hotspots.json' },
      ),
    },
    bag: data.bag,
    emit: (msg) => emit(data.runId, { type: 'stage.progress', skill: skill.name, msg }),
    signal: new AbortController().signal,
  };
  const output = await Promise.race([
    skill.run(ctx),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${skill.title} 超时（${timeoutMs}ms）`)), timeoutMs),
    ),
  ]);
  data.bag[skill.name] = output;
  await persistRun(RUNS_DIR, data.runId, data.bag);
  emit(data.runId, { type: 'stage.done', skill: skill.name, output });
  return data;
}

function skillStep(skillName: string, timeoutMs = 480_000, retries = 1) {
  return createStep({
    id: skillName,
    inputSchema: pipelineDataSchema,
    outputSchema: pipelineDataSchema,
    retries,
    execute: async ({ inputData }) => {
      try {
        return await runSkill(skillName, inputData, timeoutMs);
      } catch (error) {
        emit(inputData.runId, {
          type: 'stage.failed',
          skill: skillName,
          title: buildRegistry().get(skillName).title,
          error: error instanceof Error ? error.message : String(error),
          attempt: 1,
        });
        throw error;
      }
    },
  });
}

const topicApproval = createStep({
  id: 'topic.approval',
  inputSchema: pipelineDataSchema,
  outputSchema: pipelineDataSchema,
  resumeSchema: z.object({ choice: z.string() }),
  suspendSchema: z.object({ question: z.string(), options: z.array(z.string()) }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const topics = (inputData.bag['topic.generate'] as Array<{ id?: string }>) ?? [];
    const options = topics.map((topic) => topic.id).filter((id): id is string => !!id);
    if (!resumeData) {
      const payload = { question: '选择一个选题（输入 id）', options };
      emit(inputData.runId, { type: 'gate.waiting', skill: 'topic.generate', ...payload });
      return suspend(payload);
    }
    if (!options.includes(resumeData.choice)) throw new Error('选题不存在');
    inputData.bag['gate.topic.generate'] = resumeData.choice;
    await persistRun(RUNS_DIR, inputData.runId, inputData.bag);
    emit(inputData.runId, {
      type: 'gate',
      skill: 'topic.generate',
      question: '选择一个选题（输入 id）',
      choice: resumeData.choice,
    });
    return inputData;
  },
});

const riskApproval = createStep({
  id: 'risk.approval',
  inputSchema: pipelineDataSchema,
  outputSchema: pipelineDataSchema,
  resumeSchema: z.object({ choice: z.enum(['通过', '打回']) }),
  suspendSchema: z.object({ question: z.string(), options: z.array(z.string()) }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const payload = { question: '风控结果是否通过？', options: ['通过', '打回'] };
      emit(inputData.runId, { type: 'gate.waiting', skill: 'risk.review', ...payload });
      return suspend(payload);
    }
    inputData.bag['gate.risk.review'] = resumeData.choice;
    await persistRun(RUNS_DIR, inputData.runId, inputData.bag);
    emit(inputData.runId, {
      type: 'gate',
      skill: 'risk.review',
      question: '风控结果是否通过？',
      choice: resumeData.choice,
    });
    return inputData;
  },
});

const finish = createStep({
  id: 'finish',
  inputSchema: pipelineDataSchema,
  outputSchema: pipelineDataSchema,
  execute: async ({ inputData }) => {
    await persistRun(RUNS_DIR, inputData.runId, inputData.bag);
    emit(inputData.runId, {
      type: 'run.done',
      runId: inputData.runId,
      dir: `runs/${inputData.runId}`,
    });
    return inputData;
  },
});

export const contentPipelineWorkflow = createWorkflow({
  id: 'content-pipeline',
  inputSchema: pipelineDataSchema,
  outputSchema: pipelineDataSchema,
  retryConfig: { attempts: 1, delay: 1_000 },
})
  .then(skillStep('hotspot.fetch'))
  .then(skillStep('hotspot.recommend'))
  .then(skillStep('topic.generate'))
  .then(topicApproval)
  .then(skillStep('deep.search', 1_200_000, 0))
  .then(skillStep('content.outline'))
  .then(skillStep('content.draft'))
  .then(skillStep('content.refine', 720_000, 0))
  .then(skillStep('fact.check'))
  .then(skillStep('risk.review'))
  .then(riskApproval)
  .then(skillStep('asset.assemble'))
  .then(skillStep('image.render', 720_000, 0))
  .then(finish)
  .commit();

export class MastraPipelineRuntime {
  private constructor(private readonly mastra: Mastra) {}

  static async create(databaseUrl: string): Promise<MastraPipelineRuntime> {
    const storage = new PostgresStore({
      id: 'macro-influencer-mastra',
      connectionString: databaseUrl,
      schemaName: 'mastra',
    });
    await storage.init();
    const mastra = new Mastra({ storage, workflows: { contentPipelineWorkflow } });
    await mastra.restartAllActiveWorkflowRuns();
    return new MastraPipelineRuntime(mastra);
  }

  async start(input: {
    runId: string;
    userId: string;
    personaId: string;
    onEvent: (event: PipelineEvent) => void;
  }): Promise<void> {
    eventSinks.set(input.runId, input.onEvent);
    const workflow = this.mastra.getWorkflow('contentPipelineWorkflow');
    const run = await workflow.createRun({ runId: input.runId, resourceId: input.userId });
    input.onEvent({
      type: 'run.start',
      runId: input.runId,
      persona: input.personaId,
      stages: [
        'hotspot.fetch',
        'hotspot.recommend',
        'topic.generate',
        'deep.search',
        'content.outline',
        'content.draft',
        'content.refine',
        'fact.check',
        'risk.review',
        'asset.assemble',
        'image.render',
      ],
    });
    const bag: Record<string, unknown> = { __userId: input.userId, __personaId: input.personaId };
    await persistRun(RUNS_DIR, input.runId, bag);
    void run
      .start({
        inputData: { runId: input.runId, userId: input.userId, personaId: input.personaId, bag },
      })
      .then((result) => {
        if (result.status === 'failed') {
          input.onEvent({ type: 'run.failed', error: result.error?.message ?? '工作流失败' });
        }
      })
      .catch((error) =>
        input.onEvent({
          type: 'run.failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  async resume(
    runId: string,
    userId: string,
    step: 'topic.approval' | 'risk.approval',
    choice: string,
  ) {
    const workflow = this.mastra.getWorkflow('contentPipelineWorkflow');
    const stored = await workflow.getWorkflowRunById(runId);
    if (!stored || stored.resourceId !== userId) throw new Error('任务不存在或不属于当前用户');
    const run = await workflow.createRun({ runId, resourceId: userId });
    await run.resumeAsync({ step, resumeData: { choice } });
  }

  async findRun(
    userId: string,
    statuses: Array<'running' | 'pending' | 'waiting' | 'suspended' | 'failed'>,
  ): Promise<{ runId: string; status: string; suspendedStep?: string } | null> {
    const workflow = this.mastra.getWorkflow('contentPipelineWorkflow');
    for (const status of statuses) {
      const { runs } = await workflow.listWorkflowRuns({ resourceId: userId, status, perPage: 20 });
      const latest = runs.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      if (!latest) continue;
      const snapshot =
        typeof latest.snapshot === 'string' ? JSON.parse(latest.snapshot) : latest.snapshot;
      return {
        runId: latest.runId,
        status,
        suspendedStep: Object.keys(snapshot.suspendedPaths ?? {})[0],
      };
    }
    return null;
  }

  async restart(runId: string, userId: string): Promise<void> {
    const workflow = this.mastra.getWorkflow('contentPipelineWorkflow');
    const stored = await workflow.getWorkflowRunById(runId);
    if (!stored || stored.resourceId !== userId) throw new Error('任务不存在或不属于当前用户');
    const run = await workflow.createRun({ runId, resourceId: userId });
    void run.restart();
  }
}
