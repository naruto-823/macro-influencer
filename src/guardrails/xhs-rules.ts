import type { RiskHit } from '../engine/types.js';

/** 词库：category → 词 → 严重度。可后续外置成 JSON 热加载。 */
export const SENSITIVE_LEXICON: Array<{
  category: string;
  severity: RiskHit['severity'];
  terms: string[];
}> = [
  {
    category: '极限词',
    severity: 'mid',
    terms: ['最', '第一', '顶级', '国家级', '绝对', '百分百'],
  },
  {
    category: '医疗功效',
    severity: 'high',
    terms: ['治疗', '根治', '疗效', '抗癌', '消炎', '杀菌'],
  },
  { category: '导流词', severity: 'high', terms: ['微信', '加V', '私信我', 'vx', '威信'] },
  { category: '政治敏感', severity: 'high', terms: ['政府', '领导人'] },
];
