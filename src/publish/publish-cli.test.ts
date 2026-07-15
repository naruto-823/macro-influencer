import { describe, expect, it } from 'vitest';
import { parsePublishArgs } from './publish-cli.js';

describe('parsePublishArgs', () => {
  it('defaults: no runId, llm on', () => {
    expect(parsePublishArgs([])).toEqual({ noLlm: false });
  });
  it('takes a runId', () => {
    expect(parsePublishArgs(['run-abc'])).toEqual({ runId: 'run-abc', noLlm: false });
  });
  it('latest keyword is not treated as runId', () => {
    expect(parsePublishArgs(['latest'])).toEqual({ noLlm: false });
  });
  it('--no-llm flag', () => {
    expect(parsePublishArgs(['run-abc', '--no-llm'])).toEqual({
      runId: 'run-abc',
      noLlm: true,
    });
  });
});
