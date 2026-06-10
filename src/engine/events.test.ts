import { describe, expect, it } from 'vitest';
import { EventBus, type PipelineEvent } from './events.js';

describe('EventBus', () => {
  it('广播给所有订阅者', () => {
    const bus = new EventBus();
    const a: PipelineEvent[] = [];
    const b: PipelineEvent[] = [];
    bus.on((e) => a.push(e));
    bus.on((e) => b.push(e));
    bus.emit({ type: 'run.start', runId: 'r1', persona: '棍子大人', stages: ['x'] });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toMatchObject({ type: 'run.start', runId: 'r1' });
  });

  it('取消订阅后不再收到', () => {
    const bus = new EventBus();
    const got: PipelineEvent[] = [];
    const off = bus.on((e) => got.push(e));
    off();
    bus.emit({ type: 'run.done', runId: 'r1', dir: '/tmp/x' });
    expect(got).toHaveLength(0);
    expect(bus.size).toBe(0);
  });
});
