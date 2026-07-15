import { describe, expect, it } from 'vitest';
import { parseDailyArgs } from './daily.js';

describe('parseDailyArgs', () => {
  it('defaults: gunzi-daren persona, package-only', () => {
    expect(parseDailyArgs([])).toEqual({ persona: 'gunzi-daren', live: false, draft: false });
  });
  it('--live', () => {
    expect(parseDailyArgs(['--live']).live).toBe(true);
  });
  it('--draft', () => {
    expect(parseDailyArgs(['--draft']).draft).toBe(true);
  });
  it('--persona <id> and --persona=<id>', () => {
    expect(parseDailyArgs(['--persona', 'foo']).persona).toBe('foo');
    expect(parseDailyArgs(['--persona=bar']).persona).toBe('bar');
  });
});
