import { describe, expect, it } from 'vitest';
import { extractCookieString, parseCookiePairs } from './auth-setup.js';
import { parseDriverArgs } from './xhs-driver.js';

describe('parseDriverArgs', () => {
  it('defaults to draft mode, session xhs', () => {
    expect(parseDriverArgs([])).toEqual({ live: false, session: 'xhs' });
  });
  it('takes runId + --live', () => {
    expect(parseDriverArgs(['run-abc', '--live'])).toEqual({
      runId: 'run-abc',
      live: true,
      session: 'xhs',
    });
  });
  it('custom session', () => {
    expect(parseDriverArgs(['--session', 'foo'])).toEqual({ live: false, session: 'foo' });
  });
  it('latest is not a runId', () => {
    expect(parseDriverArgs(['latest'])).toEqual({ live: false, session: 'xhs' });
  });
});

describe('extractCookieString', () => {
  it('pulls -b from a curl', () => {
    const curl = "curl 'https://x' -b 'a=1; b=2' -H 'x: y'";
    expect(extractCookieString(curl)).toBe('a=1; b=2');
  });
  it('passes through a bare cookie string', () => {
    expect(extractCookieString('a=1; b=2')).toBe('a=1; b=2');
  });
});

describe('parseCookiePairs', () => {
  it('splits on ; and first =', () => {
    expect(parseCookiePairs('a=1; b=2; token=x=y+z')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'token', value: 'x=y+z' },
    ]);
  });
  it('drops empty', () => {
    expect(parseCookiePairs('a=1;; =2; b=')).toEqual([{ name: 'a', value: '1' }]);
  });
});
