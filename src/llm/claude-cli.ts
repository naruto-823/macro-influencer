import { spawn } from 'node:child_process';
import {
  ClaudeLlmClient,
  type LlmClient,
  type LlmCompleteOpts,
  type LlmResearchOpts,
  type LlmResearchResult,
  parseJson,
} from './client.js';
import { traceLlm } from './trace.js';

/**
 * 调用本机 `claude -p`（用户自己的 Claude 授权），prompt 走 stdin。绕开 fox 代理的截断/429/524。
 * extraArgs 用于按需放开工具（如 deepsearch 的 --allowedTools WebSearch WebFetch）。
 */
function runClaudeCli(
  prompt: string,
  timeoutMs = 240_000,
  extraArgs: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', ['-p', ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  // claude -p 无 tool-use，裸 JSON 里若有未转义引号会解析失败；这时回退 fox 的 tool-use（保证合法 JSON）。
  private _fox: ClaudeLlmClient | null = null;
  private get fox(): ClaudeLlmClient {
    this._fox ??= new ClaudeLlmClient();
    return this._fox;
  }

  async complete(opts: LlmCompleteOpts): Promise<string> {
    return traceLlm(
      'cli.complete',
      { model: 'claude-cli', inChars: opts.prompt.length },
      async () => {
        const prompt = (opts.system ? `${opts.system}\n\n` : '') + opts.prompt;
        try {
          const out = stripBaobao(await runClaudeCli(prompt, 360_000));
          return { result: out, extra: { via: 'claude-cli' } };
        } catch (e) {
          // claude -p 超时/非零退出 → 回退 fox 的纯文本生成，绝不让长文生成整个崩。
          const result = await this.fox.complete(opts);
          return {
            result,
            extra: { via: 'fox-fallback', cliError: e instanceof Error ? e.message : String(e) },
          };
        }
      },
    );
  }

  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    return traceLlm(
      'cli.completeJson',
      { model: 'claude-cli', inChars: opts.prompt.length },
      async () => {
        const prompt = `${opts.system ? `${opts.system}\n\n` : ''}${opts.prompt}\n\n只输出 JSON，不要任何解释、前后缀或 markdown 代码块。`;
        try {
          // 长文结构化输出给足 360s；超时/退出码/解析失败都走 fox 兜底，绝不让整个 skill 崩。
          const out = await runClaudeCli(prompt, 360_000);
          return { result: parseJson<T>(out), extra: { via: 'claude-cli' } };
        } catch (e) {
          // claude -p 超时 / 非零退出 / 裸 JSON 解析失败 → 回退 fox 的 tool-use（合法且不被长文截断）。
          const result = await this.fox.completeJson<T>(opts);
          return {
            result,
            extra: { via: 'fox-fallback', cliError: e instanceof Error ? e.message : String(e) },
          };
        }
      },
    );
  }

  /**
   * 联网深度调研：放开 WebSearch/WebFetch，让本机 claude 真正去检索真实资料后产出档案。
   * 返回纯文本（不强制 JSON，避免长报告里引号/链接破坏解析）。
   */
  async research(opts: LlmResearchOpts): Promise<LlmResearchResult> {
    return traceLlm(
      'cli.research',
      { model: 'claude-cli', inChars: opts.prompt.length, web: true },
      async () => {
        const prompt = (opts.system ? `${opts.system}\n\n` : '') + opts.prompt;
        const out = stripBaobao(
          await runClaudeCli(prompt, opts.timeoutMs ?? 420_000, [
            '--allowedTools',
            'WebSearch',
            'WebFetch',
          ]),
        );
        return {
          result: { text: out, online: true },
          extra: { via: 'claude-cli', tools: 'WebSearch,WebFetch' },
        };
      },
    );
  }
}
