import { describe, expect, it } from 'vitest';
import { contentPipelineWorkflow } from './pipeline.js';

describe('Mastra 内容生产工作流', () => {
  it('每个长耗时业务阶段都是独立持久化 Step，并包含两个人工暂停点', () => {
    const ids = contentPipelineWorkflow.serializedStepGraph.map((entry) =>
      'step' in entry ? entry.step.id : entry.type,
    );
    expect(ids).toEqual([
      'hotspot.fetch',
      'hotspot.recommend',
      'topic.generate',
      'topic.approval',
      'deep.search',
      'content.outline',
      'content.draft',
      'content.refine',
      'fact.check',
      'risk.review',
      'risk.approval',
      'asset.assemble',
      'image.render',
      'finish',
    ]);
  });
});
