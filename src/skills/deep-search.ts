import type { DeepResearch, Hotspot, RecommendedHotspot, Skill, Topic } from '../engine/types.js';

/** 从调研报告里抽出真实链接（http/https），去重，最多 12 条，给 UI 列「参考资料」。 */
function extractSources(report: string): string[] {
  const urls = report.match(/https?:\/\/[^\s)\]）】"'，。、]+/g) ?? [];
  return [...new Set(urls)].slice(0, 12);
}

/**
 * ② 深度调研：基于选定的选题/热点，联网检索大量真实靠谱的资料，产出一份事实档案，
 * 作为后续初稿的底料（确保内容扎实可信、有信息增量，而非空泛而谈）。
 */
export const deepSearchSkill: Skill<DeepResearch> = {
  name: 'deep.search',
  title: '② 深度调研',
  async run(ctx) {
    const topics = (ctx.bag['topic.generate'] as Topic[]) ?? [];
    const choiceId = ctx.bag['gate.topic.generate'] as string | undefined;
    const topic = topics.find((t) => t.id === choiceId) ?? topics[0];
    if (!topic) throw new Error('deep.search: 没有可用选题');

    // 选题往往脱胎于某条精选热点，带上它的「爆点/角度」让调研更聚焦。
    const recs = (ctx.bag['hotspot.recommend'] as RecommendedHotspot[]) ?? [];
    const overlapScore = (a: string, b: string): number => {
      const clean = a.replace(/[\s\p{P}]/gu, '');
      let score = 0;
      for (let i = 0; i <= clean.length - 4; i++) {
        if (b.includes(clean.slice(i, i + 4))) score++;
      }
      return score;
    };
    const exactRec = recs.find(
      (r) => topic.title.includes(r.title) || r.title.includes(topic.title),
    );
    const rankedRec = recs
      .map((r) => ({ r, score: overlapScore(r.title, topic.title) }))
      .sort((a, b) => b.score - a.score)[0];
    const rec =
      exactRec ??
      (rankedRec && rankedRec.score > 0 ? rankedRec.r : recs.length === 1 ? recs[0] : undefined);
    const hotspots = (ctx.bag['hotspot.fetch'] as Hotspot[]) ?? [];
    const seed = hotspots.find(
      (h) =>
        h.title === rec?.title || topic.title.includes(h.title) || h.title.includes(topic.title),
    );
    const seedEvidence = seed
      ? [
          `原始热榜来源：${seed.source}`,
          `原始热榜标题：${seed.title}`,
          seed.summary ? `原始热榜摘要：${seed.summary}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '（没有可用的原始热榜摘要）';

    const system =
      '你是顶级深度调研记者。你必须用 WebSearch/WebFetch 去检索真实、可靠、尽量新的公开资料，' +
      '基于查到的事实写调研档案。严禁编造人物、数据、时间、引述；拿不准的就标注「未核实」。每个关键事实尽量注明来源链接。';
    const prompt = [
      `调研选题：${topic.title}`,
      `切入角度：${topic.angle}`,
      rec ? `关联热点：${rec.title}（来源：${rec.source}）` : '',
      rec ? `爆点提示：${rec.reason}` : '',
      seedEvidence,
      '',
      '【检索策略 —— 必须照做，这是中文热点，不许偷懒】：',
      '· 别上来就搜整句论点。先搜核心实体：人名 / 公司名 / 事件名（连带其拼音或英文名），再逐步搜具体细节、时间、数据。换多种说法多搜几轮。',
      '· WebSearch 对中文新近话题经常返回空——这时务必改用 WebFetch 抓中文搜索引擎结果页，再抓具体文章页：',
      '  - 必应中文：https://www.bing.com/search?q=关键词（关键词用空格分隔，整段做 URL 编码）',
      '  - 百度：https://www.baidu.com/s?wd=关键词',
      '  从结果页里找出腾讯/澎湃/网易/新浪/知乎/百科等真实文章链接，再 WebFetch 那些文章页拿到准确细节。',
      '· 【铁律】绝不许因为"搜不到"就整篇放弃或退回让我提供链接。穷尽上面的检索手段后，用你真正查到的内容写档案；个别查不到的点就标「未核实」，但不要编造，也不要只写一句道歉。',
      '',
      '检索充分后，产出一份给写手用的「事实档案」，要求真实、具体、可直接引用。包含：',
      '1. 一句话背景：这是什么人/什么事，为什么现在火。',
      '2. 关键事实清单：6-12 条经核实的硬事实（带具体时间、数字、人名、地点；每条尽量附来源链接）。',
      '3. 时间线：按时间梳理事件的来龙去脉 / 人物的关键节点。',
      '4. 各方观点与争议：不同立场怎么说，争议点在哪，避免一边倒。',
      '5. 可写的爆点与金句素材：最有冲击力、最反常识、最能引发共鸣的几个点。',
      '6. 对普通人的意义：这事/这个人能给读者什么启发或警示。',
      '最后用「## 参考资料」列出你实际引用过的真实链接（逐条列 URL）。',
      '',
      '直接输出 markdown 档案正文，不要客套、不要复述本提示词。',
    ]
      .filter(Boolean)
      .join('\n');

    const offlineSystem =
      '你是严谨的资料编辑。当前环境没有联网能力，也没有 WebSearch/WebFetch。' +
      '严禁声称自己搜索过必应、百度或任何网站，严禁输出 <web_search>/<web_fetch> 标签，严禁编造链接、数据、引语和检索次数。' +
      '只能使用提示中给出的“原始热榜来源/标题/摘要”作为本事件的事实材料；模型常识只能用于不带具体数字的背景说明，并明确标成背景常识。';
    const offlinePrompt = [
      `选题：${topic.title}`,
      `角度：${topic.angle}`,
      '',
      '【当前唯一可追溯的事件材料】',
      seedEvidence,
      '',
      '请生成一份“有限证据档案”：',
      '1. 先逐条复述原始热榜摘要明确提供的事实，不得扩写摘要没有的情节。',
      '2. 把无法由摘要确认的内容列入“不可使用的信息”，供写手避开。',
      '3. 可以给出不依赖具体数据的行业背景与写作角度，但必须标注“背景分析，不是本事件事实”。',
      '4. 明确写出来源名称。不要假装检索，不要输出虚构参考链接。',
      seed?.summary
        ? '材料足以支持有限度写作；正文必须使用“据该热榜题干/摘要”一类来源限定。'
        : [
            '当前只有热榜题干，没有摘要。仍需产出可供后续写作的档案，不要建议换题、不要拒绝完成。',
            '把“该标题出现在上述来源热榜”列为唯一事件事实；标题中出现的数字、排名、身份和因果均视为未经核实的题干说法，不能转述成已证实事实。',
            '其余内容只提供不带具体数字的通用行业背景、分析框架、应核实的问题清单和安全写作角度，并逐段标注“背景分析，不是本事件事实”。',
            '后续正文应写成基于热榜题干引发的趋势分析，不得写成对题干细节的新闻确认稿。',
          ].join('\n'),
    ].join('\n');

    let report: string;
    let online: boolean;
    if (typeof ctx.llm.research === 'function') {
      try {
        const r = await ctx.llm.research({ system, prompt });
        report = r.text;
        online = r.online;
      } catch (e) {
        // 联网调研失败（超时/工具不可用）→ 退回模型知识，保证流水线不断；正文里标注无实时检索。
        ctx.emit(`  联网调研失败，退回模型知识：${e instanceof Error ? e.message : String(e)}`);
        report = await ctx.llm.complete({ system: offlineSystem, prompt: offlinePrompt });
        online = false;
      }
    } else {
      // 后端不支持联网（如 fox）→ 只基于原始热榜材料整理，禁止伪造检索。
      report = await ctx.llm.complete({ system: offlineSystem, prompt: offlinePrompt });
      online = false;
    }

    // 离线模型即使吐出 URL 也不可信，绝不把它们展示成“实际引用来源”。
    const sources = online ? extractSources(report) : [];
    if (
      !online &&
      /<web_(?:search|fetch)>|检索(?:了|过程|次数)|必应.{0,8}搜索|百度.{0,8}搜索/i.test(report)
    ) {
      throw new Error('离线调研伪造了搜索过程，已拦截；请重试或更换选题');
    }
    ctx.emit(
      online
        ? `  联网调研完成：${sources.length} 条来源`
        : `  有限证据整理完成（未联网，依据 ${seed?.source ?? '原始热榜'}${seed?.summary ? '题干与摘要' : '题干'}）`,
    );
    return { topic: topic.title, report, sources, online };
  },
};
