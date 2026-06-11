import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 轻量 LLM 链路追踪（OpenTelemetry 风格）。
 * - 用 AsyncLocalStorage 传播「当前 run / skill」上下文（context propagation）。
 * - 每次 LLM 调用（llm span）与底层每个 HTTP 请求（http span，含 SDK 自动重试）各记一条 span。
 * - span 以 JSONL 落盘 logs/llm-trace.jsonl，控制台同时出一行摘要，便于排查 429/超时/解析失败等。
 */

export interface TraceCtx {
  runId?: string;
  skill?: string;
}

const als = new AsyncLocalStorage<TraceCtx>();

/** 在给定上下文里执行（其内部的 LLM/HTTP span 都会带上该 runId/skill）。 */
export function withTrace<T>(ctx: TraceCtx, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function currentTrace(): TraceCtx {
  return als.getStore() ?? {};
}

export interface Span {
  ts: string;
  type: 'llm' | 'http';
  runId?: string;
  skill?: string;
  name: string;
  durationMs: number;
  ok: boolean;
  status?: number;
  error?: string;
  attrs?: Record<string, unknown>;
}

const LOG_FILE = resolve('logs', 'llm-trace.jsonl');
let dirReady: Promise<unknown> | null = null;

/** 一行控制台摘要（纯函数，便于测试）。 */
export function formatSpan(s: Span): string {
  const tag = s.ok ? '✓' : '✗';
  const parts = [
    `[llm-trace] ${tag}`,
    s.type,
    s.name,
    `${s.durationMs}ms`,
    s.status !== undefined ? `status=${s.status}` : '',
    s.skill ? `@${s.skill}` : '',
    s.error ? `ERR ${s.error}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

/** 落盘一条 span（JSONL）并打印摘要；失败静默，不影响主流程。 */
export async function logSpan(s: Span): Promise<void> {
  console.log(formatSpan(s));
  try {
    dirReady ??= mkdir(resolve('logs'), { recursive: true });
    await dirReady;
    await appendFile(LOG_FILE, `${JSON.stringify(s)}\n`);
  } catch {
    // 日志写不进去不该影响业务
  }
}

/** 包一层 fetch：记录底层每个 HTTP 请求（含 SDK 重试），traceId 取自当前上下文。 */
export const tracedFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // 保留原始字符串
  }
  const { runId, skill } = currentTrace();
  const start = Date.now();
  try {
    const res = await fetch(input, init);
    void logSpan({
      ts: new Date().toISOString(),
      type: 'http',
      runId,
      skill,
      name: host,
      durationMs: Date.now() - start,
      ok: res.ok,
      status: res.status,
    });
    return res;
  } catch (e) {
    void logSpan({
      ts: new Date().toISOString(),
      type: 'http',
      runId,
      skill,
      name: host,
      durationMs: Date.now() - start,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
};

/** 包一层 LLM 调用：记录模型/输入规模/输出 token/耗时/状态，并落 span。 */
export async function traceLlm<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<{ result: T; outTokens?: number; extra?: Record<string, unknown> }>,
): Promise<T> {
  const { runId, skill } = currentTrace();
  const start = Date.now();
  try {
    const { result, outTokens, extra } = await fn();
    void logSpan({
      ts: new Date().toISOString(),
      type: 'llm',
      runId,
      skill,
      name,
      durationMs: Date.now() - start,
      ok: true,
      attrs: { ...attrs, outTokens, ...extra },
    });
    return result;
  } catch (e) {
    const status = (e as { status?: number })?.status;
    void logSpan({
      ts: new Date().toISOString(),
      type: 'llm',
      runId,
      skill,
      name,
      durationMs: Date.now() - start,
      ok: false,
      status,
      error: e instanceof Error ? e.message : String(e),
      attrs,
    });
    throw e;
  }
}
