import type { RiskHit, RiskReport } from '../engine/types.js';
import { SENSITIVE_LEXICON } from './xhs-rules.js';

/** 扫描文本，返回所有命中的敏感词。 */
export function scanSensitive(text: string): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const group of SENSITIVE_LEXICON) {
    for (const term of group.terms) {
      if (text.includes(term)) {
        hits.push({ category: group.category, term, severity: group.severity });
      }
    }
  }
  return hits;
}

/** 由命中项汇总风险等级。 */
export function riskLevel(hits: RiskHit[]): RiskReport['level'] {
  if (hits.length === 0) return 'pass';
  if (hits.some((h) => h.severity === 'high')) return 'high';
  if (hits.some((h) => h.severity === 'mid')) return 'mid';
  return 'low';
}
