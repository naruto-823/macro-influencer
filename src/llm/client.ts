import Anthropic from '@anthropic-ai/sdk';

export interface LlmCompleteOpts {
  system?: string;
  prompt: string;
}

export interface LlmClient {
  complete(opts: LlmCompleteOpts): Promise<string>;
  completeJson<T>(opts: LlmCompleteOpts): Promise<T>;
}

/** 从模型文本里抠出 JSON（兼容被 ```json 包裹的情况）。 */
export function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.search(/[[{]/);
  const slice = start >= 0 ? raw.slice(start) : raw;
  return JSON.parse(slice) as T;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export class ClaudeLlmClient implements LlmClient {
  private readonly client: Anthropic;
  constructor(
    private readonly model: string = DEFAULT_MODEL,
    apiKey: string = process.env['ANTHROPIC_API_KEY'] ?? '',
  ) {
    this.client = new Anthropic({ apiKey });
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

  async completeJson<T>(opts: LlmCompleteOpts): Promise<T> {
    const text = await this.complete({
      ...opts,
      prompt: `${opts.prompt}\n\n只输出 JSON，不要任何解释或 markdown 代码块。`,
    });
    return parseJson<T>(text);
  }
}
