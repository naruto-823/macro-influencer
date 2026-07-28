import type { LlmClient } from '../llm/client.js';

export interface AnalyzedXhsProfile {
  sourceUrl: string;
  displayName: string;
  bio: string;
  positioning: string;
  styleGuide: string;
  topicPreferences: string[];
  sampleTitle: string;
  sampleBody: string;
  noteTitles: string[];
}

function validProfileUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.xiaohongshu.com' ||
    !/^\/user\/profile\/[a-zA-Z0-9]+\/?$/.test(url.pathname)
  ) {
    throw new Error('请粘贴有效的小红书用户主页链接');
  }
  const allowed = new URLSearchParams();
  for (const key of ['xsec_token', 'xsec_source']) {
    const value = url.searchParams.get(key);
    if (value) allowed.set(key, value);
  }
  url.search = allowed.toString();
  url.hash = '';
  return url;
}

export async function analyzeXhsProfile(
  rawUrl: string,
  llm: LlmClient,
): Promise<AnalyzedXhsProfile> {
  const url = validProfileUrl(rawUrl);
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`小红书主页访问失败（HTTP ${response.status}）`);
  const html = await response.text();
  const rawState = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s)?.[1];
  if (!rawState) throw new Error('主页未返回公开账号资料，可能需要登录或链接已失效');
  const state = JSON.parse(rawState.replace(/:undefined(?=[,}])/g, ':null')) as {
    user?: {
      userPageData?: {
        basicInfo?: { nickname?: string; desc?: string };
        notes?: Array<
          Array<{ noteCard?: { displayTitle?: string; interactInfo?: { likedCount?: string } } }>
        >;
      };
    };
  };
  const page = state.user?.userPageData;
  const displayName = page?.basicInfo?.nickname?.trim() ?? '';
  const bio = page?.basicInfo?.desc?.trim() ?? '';
  const cards = page?.notes?.flat() ?? [];
  const noteTitles = cards
    .map((item) => item.noteCard?.displayTitle?.trim() ?? '')
    .filter(Boolean)
    .slice(0, 60);
  if (!displayName) throw new Error('主页未返回账号名称，可能需要验证或链接已失效');

  const analysis = await llm.completeJson<{
    positioning: string;
    styleGuide: string;
    topicPreferences: string[];
  }>({
    system:
      '你是小红书账号分析师。只能依据提供的公开简介和笔记标题归纳，不得编造正文、身份、数据或未提供的事实。',
    prompt: `分析这个小红书账号，生成可直接用于内容创作的人设配置。\n账号名：${displayName}\n简介：${bio || '未填写'}\n公开笔记标题：\n${noteTitles.length ? noteTitles.map((title, index) => `${index + 1}. ${title}`).join('\n') : '平台未向当前抓取环境返回公开笔记，只能依据账号名和简介分析；不得推测不存在的标题或正文。'}\n\n定位需说明账号身份、目标读者和内容价值；风格需总结现有证据能支持的语气、选题角度和表达习惯；选题偏好返回 3-8 个短语。`,
    schema: {
      type: 'object',
      properties: {
        positioning: { type: 'string' },
        styleGuide: { type: 'string' },
        topicPreferences: { type: 'array', items: { type: 'string' } },
      },
      required: ['positioning', 'styleGuide', 'topicPreferences'],
      additionalProperties: false,
    },
  });
  return {
    // xsec_token 仅用于本次抓取，不持久化到账号资料。
    sourceUrl: `${url.origin}${url.pathname}`,
    displayName,
    bio,
    positioning: analysis.positioning,
    styleGuide: analysis.styleGuide,
    topicPreferences: analysis.topicPreferences,
    sampleTitle: noteTitles[0] ?? `${displayName}的公开账号资料`,
    sampleBody: noteTitles.length
      ? `公开主页未提供笔记正文。本账号分析仅依据以下公开标题：\n${noteTitles.join('\n')}`
      : `公开主页未向当前抓取环境返回笔记列表。本账号分析仅依据公开简介：\n${bio || '未填写简介'}`,
    noteTitles,
  };
}
