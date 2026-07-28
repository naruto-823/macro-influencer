import type {
  Draft,
  FactCheckReport,
  RefineResult,
  RiskFix,
  RiskReport,
  Skill,
} from '../engine/types.js';
import { riskLevel, scanSensitive } from '../guardrails/sensitive-words.js';
import { MIN_FINAL_BODY_CHARS, charCount } from './content-draft.js';

interface RawCompliance {
  fixes: Array<{ from?: string; to?: string; rule?: string }>;
}

interface RawSanitizedDraft {
  title?: string;
  body?: string;
}

/**
 * ⑦ 合规风控：静态敏感词扫描 + LLM 限流红线排查。
 * 产出「违规项 → 改写」对照清单（可见 diff），而不是悄悄整篇重写一版。
 */
export const riskReviewSkill: Skill<RiskReport> = {
  name: 'risk.review',
  title: '⑦ 合规风控',
  async run(ctx) {
    const draft = (ctx.bag['content.refine'] as RefineResult).final;
    const hits = scanSensitive(`${draft.title}\n${draft.body}`);
    const level = riskLevel(hits);
    const hitDesc = hits.length ? hits.map((h) => `「${h.term}」(${h.category})`).join('、') : '无';
    ctx.emit(`  静态敏感词：${hits.length} 处命中（${hitDesc}）`);

    // 事实核查里查无实据(🔴)/待确认(🟡)的硬数据，必须从成稿里清掉——绝不让杜撰的评分/数据发出去。
    const fc = ctx.bag['fact.check'] as FactCheckReport | undefined;
    const unverified = (fc?.claims ?? []).filter((c) => c.confidence !== 'green');
    const unverifiedBlock = unverified.length
      ? [
          '',
          '【事实核查发现这些说法查无实据/待确认，必须在改写时处理——把其中编造或不可证实的具体数字（评分/播放量/销量/百分比/日期/引语等）删掉，或改成不依赖该数字的定性说法（如「口碑下滑」），绝不能保留无依据的硬数据】：',
          ...unverified.map((c) => `· ${c.confidence === 'red' ? '🔴' : '🟡'} ${c.claim}`),
        ].join('\n')
      : '';
    if (unverified.length) ctx.emit(`  事实净化：清理 ${unverified.length} 条查无实据的说法`);

    // 静态词库之外，再用 LLM 排查小红书限流红线（极限词/夸张承诺/诱导/拉踩/绝对化/导流）。
    const raw = await ctx.llm.completeJson<RawCompliance>({
      schema: {
        type: 'object',
        properties: {
          fixes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                rule: { type: 'string' },
              },
              required: ['from', 'to', 'rule'],
            },
          },
        },
        required: ['fixes'],
      },
      system:
        '你是小红书合规审核 + 事实把关专家。你要做两件事：① 规避平台限流/违禁表述；② 把事实核查里查无实据的杜撰数据清理掉。你只产出「查找-替换」改动清单（from 必须是正文里一字不差的原句/原短语），系统会据此精确替换，所以 from 必须能在正文里精确定位。',
      prompt: [
        '排查并规避以下小红书限流/违规红线：',
        '· 极限词（最/第一/唯一/顶级/国家级…）→ 换成可证伪的具体表述或主观限定（"我用过最…"）。',
        '· 夸张承诺（100%/无副作用/绝对…）、诱导（点击领取/再不抢就没/卖疯了）。',
        '· 拉踩同行、人身攻击式定性、诛心指控（人物锐评尤其注意名誉权，结论要留有余地）。',
        '· 绝对化客观陈述无据可查的 → 删或加主观限定。导流（外站链接/二维码）。',
        hits.length ? `· 另外这些静态命中也要处理：${hitDesc}` : '',
        unverifiedBlock,
        '',
        `标题：${draft.title}`,
        `正文：\n${draft.body}`,
        '',
        '输出 JSON：{"fixes":[{"from":"正文里一字不差的原句/原短语","to":"改后表述","rule":"命中的规则(合规红线 或 事实存疑)"}]}。',
        'from 必须是上面标题或正文里能精确匹配到的连续文字（含标点）；to 是替换成的内容。查无实据的硬数据务必都列进来改成定性说法。若通篇无问题，fixes 为空数组。',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    // 不信 LLM 整篇 rewritten（它常列了 fixes 却没真应用进全文）；按 fixes 清单对原文做确定性 search-replace。
    const rawFixes = (Array.isArray(raw?.fixes) ? raw.fixes : []).filter((f) => f?.from && f?.to);
    let title = draft.title;
    let body = draft.body;
    const fixes: RiskFix[] = [];
    for (const f of rawFixes) {
      const from = String(f.from);
      const to = String(f.to);
      if (from === to) continue;
      if (body.includes(from)) {
        body = body.split(from).join(to);
        fixes.push({ from, to, rule: String(f.rule ?? '') });
      } else if (title.includes(from)) {
        title = title.split(from).join(to);
        fixes.push({ from, to, rule: String(f.rule ?? '') });
      }
      // from 在正文里精确匹配不到的（LLM 引述不准）就跳过，避免误伤——这条会留在 fixes 外、可在日志看到。
    }
    // 模型有时会返回空 fixes，或 from 并非原文的精确子串，导致“说要净化但实际 0 修改”。
    // 有非绿事实却一处都没改时，强制走整稿净化兜底，绝不允许原稿原样通过。
    if (unverified.length > 0 && fixes.length === 0) {
      ctx.emit('  逐句净化未命中，启动整稿事实净化兜底');
      const sanitized = await ctx.llm.completeJson<RawSanitizedDraft>({
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['title', 'body'],
        },
        system:
          '你是事实编辑。必须完整保留文章的观点、结构和已核实事实，同时删除、弱化或加限定语处理所有未核实说法。禁止添加任何新数字、新引语、新事实；禁止原样返回。',
        prompt: [
          '请净化下面的稿件。',
          '处理规则：',
          '1. 🔴说法必须删除，或改成不依赖该事实的观点表达。',
          '2. 🟡说法必须删除具体数字/日期/引语/绝对断言，改成“据公开信息”“有媒体报道”“可能”等审慎定性表达；没有可靠依据时直接删除。',
          '3. 不得新增事实，不得改变核心观点和段落顺序。',
          '4. 输出的 title/body 必须与原稿不同。',
          `5. 正文不得少于 ${MIN_FINAL_BODY_CHARS} 字；只做必要替换，不得压缩成短稿。`,
          '',
          '【必须处理的非绿事实】',
          ...unverified.map(
            (c) => `· ${c.confidence === 'red' ? '🔴' : '🟡'} ${c.claim}；原因：${c.basis}`,
          ),
          '',
          `【原标题】${title}`,
          `【原正文】\n${body}`,
        ].join('\n'),
      });
      const nextTitle = String(sanitized?.title ?? '').trim();
      const nextBody = String(sanitized?.body ?? '').trim();
      if (
        !nextTitle ||
        charCount(nextBody) < MIN_FINAL_BODY_CHARS ||
        (nextTitle === title && nextBody === body)
      ) {
        throw new Error('事实净化失败：存在非绿事实，但模型未产出有效修改稿');
      }
      title = nextTitle;
      body = nextBody;
      fixes.push({
        from: '整篇原稿',
        to: '事实净化稿',
        rule: `事实存疑兜底（处理 ${unverified.length} 条）`,
      });
    }
    const rewritten: Draft = { title, body };
    ctx.emit(`  合规+净化：实际应用 ${fixes.length}/${rawFixes.length} 处改写`);
    return { hits, level, fixes, rewritten };
  },
};
