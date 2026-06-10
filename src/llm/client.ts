import Anthropic from '@anthropic-ai/sdk';

export interface LlmCompleteOpts {
  system?: string;
  prompt: string;
  /** 结构化输出的 JSON Schema：传给 completeJson 时约束模型输出结构（tool-use input_schema）。 */
  schema?: Record<string, unknown>;
}

export interface LlmClient {
  complete(opts: LlmCompleteOpts): Promise<string>;
  completeJson<T>(opts: LlmCompleteOpts): Promise<T>;
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
    this.client = new Anthropic({ apiKey, baseURL: baseURL || undefined });
  }

  async complete(opts: LlmCompleteOpts): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  /**
   * 结构化输出：用 Anthropic tool-use 强制模型通过工具调用返回，
   * JSON 由 API 层保证合法（避免 LLM 直接写 JSON 时字符串里裸引号/换行导致解析失败）。
   * 取不到 tool_use 时退回文本 + parseJson 容错。
   */
  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    const req = {
      model: this.model,
      max_tokens: 4096,
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
    // 个别情况下代理未强制 tool_choice、返回普通文本；重试一次再退回文本解析。
    let lastText = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.messages.create(req);
      const tool = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (tool) return tool.input as T;
      lastText = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
    return parseJson<T>(lastText);
  }
}
