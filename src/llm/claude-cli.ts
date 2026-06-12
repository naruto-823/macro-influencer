import { spawn } from 'node:child_process';
import { type LlmClient, type LlmCompleteOpts, parseJson } from './client.js';
import { traceLlm } from './trace.js';

/** 调用本机 `claude -p`（用户自己的 Claude 授权），prompt 走 stdin。绕开 fox 代理的截断/429/524。 */
function runClaudeCli(prompt: string, timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      cp.kill('SIGKILL');
      reject(new Error(`claude -p 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    cp.stdout.on('data', (d) => {
      out += d;
    });
    cp.stderr.on('data', (d) => {
      err += d;
    });
    cp.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p 退出码 ${code}: ${err.slice(0, 200)}`));
    });
    cp.stdin.write(prompt);
    cp.stdin.end();
  });
}

/** 去掉全局 CLAUDE.md 强制追加的“宝宝”尾巴（仅纯文本路径需要；JSON 路径由 parseJson 自动忽略）。 */
function stripBaobao(s: string): string {
  return s.replace(/\s*宝宝\s*[。.!！]?\s*$/u, '').trim();
}

/**
 * 基于本机 `claude -p` 的 LLM 客户端：用用户自己的 Claude（Opus）授权生成，
 * 彻底绕开 fox 代理的长文本截断与限流。结构化输出靠 parseJson 容错解析（claude -p 无 tool-use）。
 */
export class ClaudeCliClient implements LlmClient {
  async complete(opts: LlmCompleteOpts): Promise<string> {
    return traceLlm(
      'cli.complete',
      { model: 'claude-cli', inChars: opts.prompt.length },
      async () => {
        const prompt = (opts.system ? `${opts.system}\n\n` : '') + opts.prompt;
        const out = stripBaobao(await runClaudeCli(prompt));
        return { result: out, extra: { via: 'claude-cli' } };
      },
    );
  }

  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    return traceLlm(
      'cli.completeJson',
      { model: 'claude-cli', inChars: opts.prompt.length },
      async () => {
        const prompt = `${opts.system ? `${opts.system}\n\n` : ''}${opts.prompt}\n\n只输出 JSON，不要任何解释、前后缀或 markdown 代码块。`;
        const out = await runClaudeCli(prompt);
        return { result: parseJson<T>(out), extra: { via: 'claude-cli' } };
      },
    );
  }
}
