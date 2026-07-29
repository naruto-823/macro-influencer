export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; MacroInfluencerResearch/1.0)';

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function plainText(value: string): string {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseBingRss(xml: string): WebSearchHit[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map((match) => {
      const item = match[1] ?? '';
      const value = (tag: string) =>
        decodeEntities(item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? '');
      return {
        title: plainText(value('title')),
        url: value('link').trim(),
        snippet: plainText(value('description')),
      };
    })
    .filter((hit) => /^https?:\/\//.test(hit.url));
}

export function parseBingHtml(html: string): WebSearchHit[] {
  return [...html.matchAll(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => {
      const block = match[1] ?? '';
      const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>/i);
      return {
        url: decodeEntities(anchor?.[1] ?? ''),
        title: plainText(anchor?.[2] ?? ''),
        snippet: plainText(block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? ''),
      };
    })
    .filter((hit) => /^https?:\/\//.test(hit.url) && !/bing\.com|microsoft\.com/i.test(hit.url));
}

async function getText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function searchPublicWeb(topic: string): Promise<{ materials: string[]; hits: WebSearchHit[] }> {
  const query = encodeURIComponent(topic);
  const failures: string[] = [];
  let hits: WebSearchHit[] = [];

  try {
    hits = parseBingRss(await getText(`https://www.bing.com/search?format=rss&q=${query}`, 20_000));
  } catch (error) {
    failures.push(`Bing RSS：${error instanceof Error ? error.message : String(error)}`);
  }
  if (hits.length === 0) {
    try {
      hits = parseBingHtml(await getText(`https://www.bing.com/search?q=${query}`, 20_000));
    } catch (error) {
      failures.push(`Bing HTML：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  hits = [...new Map(hits.map((hit) => [hit.url, hit])).values()].slice(0, 8);
  if (hits.length === 0) {
    throw new Error(`公网搜索没有返回有效结果${failures.length ? `（${failures.join('；')}）` : ''}`);
  }

  const pages = await Promise.all(
    hits.slice(0, 6).map(async (hit) => {
      try {
        const body = plainText(await getText(hit.url, 15_000)).slice(0, 12_000);
        return body.length > 200 ? `来源：${hit.url}\n网页正文摘录：${body}` : '';
      } catch {
        return '';
      }
    }),
  );
  const materials = pages.filter(Boolean);
  for (const hit of hits) {
    if (hit.snippet && !materials.some((material) => material.startsWith(`来源：${hit.url}\n`))) {
      materials.push(
        `来源：${hit.url}\n搜索结果标题：${hit.title || '（无标题）'}\n搜索结果摘要（未读取到网页全文，只能作为线索，不能支撑精确数字或引语）：${hit.snippet}`,
      );
    }
  }
  if (materials.length === 0) throw new Error('公网搜索结果不含可用正文或摘要');
  return { materials, hits };
}
