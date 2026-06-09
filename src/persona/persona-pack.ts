/** 历史笔记样本 */
export interface SampleNote {
  title: string;
  body: string;
  metrics?: { likes?: number; collects?: number; comments?: number };
}

/** 声明式账号配置：加一个账号 = 写一份 PersonaPack。 */
export interface PersonaPack {
  /** 账号唯一标识，kebab-case */
  id: string;
  /** 账号展示名 */
  displayName: string;
  /** 人设定位：是谁、给谁看、提供什么价值 */
  positioning: string;
  /** 内容风格指南：语气、句式、emoji 习惯、结构偏好 */
  styleGuide: string;
  /** 历史爆款笔记样本 */
  sampleNotes: SampleNote[];
  /** 选题偏好方向 */
  topicPreferences?: string[];
  /** 内容禁区 */
  forbiddenZones?: string[];
  /** 打磨打分阈值（满分100），缺省 80 */
  refineThreshold?: number;
  /** 打磨最大轮数，缺省 3 */
  maxRefineRounds?: number;
}

export function definePersona(
  p: PersonaPack,
): Required<Pick<PersonaPack, 'refineThreshold' | 'maxRefineRounds'>> & PersonaPack {
  if (!p.id || !/^[a-z0-9-]+$/.test(p.id)) {
    throw new Error(`PersonaPack.id 非法: ${JSON.stringify(p.id)}（要求 kebab-case）`);
  }
  if (!p.displayName?.trim()) throw new Error(`PersonaPack(${p.id}).displayName 必填`);
  if (!p.positioning?.trim()) throw new Error(`PersonaPack(${p.id}).positioning 必填`);
  if (!p.styleGuide?.trim()) throw new Error(`PersonaPack(${p.id}).styleGuide 必填`);
  if (!p.sampleNotes?.length) throw new Error(`PersonaPack(${p.id}).sampleNotes 至少 1 条`);
  return {
    ...p,
    refineThreshold: p.refineThreshold ?? 80,
    maxRefineRounds: p.maxRefineRounds ?? 3,
  };
}
