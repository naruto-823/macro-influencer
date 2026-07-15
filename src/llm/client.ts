import Anthropic from '@anthropic-ai/sdk';
import { traceLlm, tracedFetch } from './trace.js';

export interface LlmCompleteOpts {
  system?: string;
  prompt: string;
  /** 结构化输出的 JSON Schema：传给 completeJson 时约束模型输出结构（tool-use input_schema）。 */
  schema?: Record<string, unknown>;
}

/** 联网深度调研的入参与产物。 */
export interface LlmResearchOpts {
  system?: string;
  prompt: string;
  /** 允许的最长耗时（联网检索较慢，默认由实现给足）。 */
  timeoutMs?: number;
}
export interface LlmResearchResult {
  /** 调研正文（markdown 纯文本） */
  text: string;
  /** 是否真·联网（实现支持 web 工具时为 true） */
  online: boolean;
}

export interface LlmClient {
  complete(opts: LlmCompleteOpts): Promise<string>;
  completeJson<T>(opts: LlmCompleteOpts): Promise<T>;
  /** 可选：联网深度调研（允许 WebSearch/WebFetch）。仅 claude -p 后端支持；不支持则缺省。 */
  research?(opts: LlmResearchOpts): Promise<LlmResearchResult>;
}

/**
 * 从模型文本里抠出 JSON 并尽量容错解析。
 * 兼容：被 ```json 包裹、JSON 前后有解释文字、以及字符串字面量里有裸换行/制表符
 * （LLM 写中文正文时极常见，裸控制字符会让 JSON.parse 报错）。
 */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const candidate = extractBalancedJson(raw);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return JSON.parse(escapeControlCharsInStrings(candidate)) as T;
  }
}

/** 从首个 { 或 [ 截到与之匹配的闭合括号，丢掉 JSON 前后的多余文字。 */
function extractBalancedJson(s: string): string {
  const start = s.search(/[[{]/);
  if (start < 0) return s;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start);
}

/** 把字符串字面量内部的裸换行/回车/制表符转义为合法的 \n \r \t。 */
function escapeControlCharsInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && ch === '\n') out += '\\n';
    else if (inStr && ch === '\r') out += '\\r';
    else if (inStr && ch === '\t') out += '\\t';
    else out += ch;
  }
  return out;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface ClaudeOpts {
  /** 模型，缺省读 ANTHROPIC_MODEL，再缺省 claude-sonnet-4-6 */
  model?: string;
  /** API key，缺省读 ANTHROPIC_API_KEY */
  apiKey?: string;
  /** 自定义网关地址（如公司合规代理 fox），缺省读 ANTHROPIC_BASE_URL；不设则走官方 */
  baseURL?: string;
}

export class ClaudeLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  constructor(opts: ClaudeOpts = {}) {
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    const baseURL = opts.baseURL ?? process.env.ANTHROPIC_BASE_URL;
    // maxRetries：SDK 对 429/5xx 自动退避重试并尊重 retry-after，应对 fox 代理限流（默认 2，调高更稳）。
    // fetch：自定义以记录底层每个 HTTP 请求（含重试）的链路 span。
    const clientOpts = {
      apiKey,
      baseURL: baseURL || undefined,
      maxRetries: 6,
      // 单请求硬超时，防止 fox 网络挂起导致整条调用永久卡住（进而把重试锁锁死）。
      timeout: 180_000,
    } as ConstructorParameters<typeof Anthropic>[0];
    (clientOpts as { fetch?: unknown }).fetch = tracedFetch;
    this.client = new Anthropic(clientOpts);
  }

  async complete(opts: LlmCompleteOpts): Promise<string> {
    return traceLlm('complete', { model: this.model, inChars: opts.prompt.length }, async () => {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 8192,
        system: opts.system,
        messages: [{ role: 'user', content: opts.prompt }],
      });
      const result = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { result, outTokens: res.usage.output_tokens, extra: { stop: res.stop_reason } };
    });
  }

  /**
   * 结构化输出：用 Anthropic tool-use 强制模型通过工具调用返回，
   * JSON 由 API 层保证合法（避免 LLM 直接写 JSON 时字符串里裸引号/换行导致解析失败）。
   * 取不到 tool_use 时退回文本 + parseJson 容错。
   */
  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    const req = {
      model: this.model,
      max_tokens: 8192,
      system: opts.system,
      messages: [{ role: 'user' as const, content: opts.prompt }],
      tools: [
        {
          name: 'emit_result',
          description: '把结果按要求的字段结构化输出。所有内容都通过本工具返回，不要写普通文本。',
          input_schema: (opts.schema ?? {
            type: 'object',
            additionalProperties: true,
          }) as Anthropic.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool' as const, name: 'emit_result' },
    };
    return traceLlm(
      'completeJson',
      { model: this.model, inChars: opts.prompt.length, hasSchema: !!opts.schema },
      async () => {
        // 个别情况下代理未强制 tool_choice、返回普通文本；重试一次再退回文本解析。
        let lastText = '';
        let lastTokens: number | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await this.client.messages.create(req);
          lastTokens = res.usage.output_tokens;
          const tool = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
          if (tool) {
            return {
              result: tool.input as T,
              outTokens: lastTokens,
              extra: { via: 'tool_use', stop: res.stop_reason },
            };
          }
          lastText = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
        }
        return {
          result: parseJson<T>(lastText),
          outTokens: lastTokens,
          extra: { via: 'text_fallback' },
        };
      },
    );
  }
}
