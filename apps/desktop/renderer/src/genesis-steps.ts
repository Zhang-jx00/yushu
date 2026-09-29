/**
 * 起源工作台步骤配置（T1-6）。
 * 设计约束：每步 2~4 个问题（严禁巨型表单）；可跳过/稍后补充；层级关闭时该步隐藏。
 * 每步产出一张设定卡：回答写入 extensions.answers（结构化），并生成可读正文。
 */

export interface StepField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
}

export interface GenesisStep {
  key: string;
  title: string;
  /** 对应 world.layers 键：该层关闭时步骤禁用 */
  layer: string;
  intro: string;
  /** 产出的设定卡 type */
  type: string;
  /** 用哪个字段作为设定卡名称 */
  nameField: string;
  fields: StepField[];
}

export const GENESIS_STEPS: GenesisStep[] = [
  {
    key: "genesis",
    title: "起源",
    layer: "genesis",
    intro: "世界的来处：创世事件与它留下的代价。",
    type: "event",
    nameField: "origin_event",
    fields: [
      {
        key: "origin_event",
        label: "创世事件",
        required: true,
        placeholder: "如：混沌中第一缕灵光开天，天柱折断化为五域",
      },
      { key: "cost", label: "代价与遗留物", placeholder: "世界为创世付出了什么" },
      { key: "motif", label: "神话母题", placeholder: "混沌生序 / 尸体化生 / 洪水…（可留空）" },
    ],
  },
  {
    key: "laws",
    title: "法则",
    layer: "laws",
    intro: "力量如何运行、代价是什么、底线在哪。",
    type: "law",
    nameField: "power_source",
    fields: [
      { key: "power_source", label: "力量来源", required: true, placeholder: "灵气 / 斗气 / 血脉 / 信仰" },
      { key: "power_cost", label: "力量的代价", placeholder: "修行要付出什么（寿元/心性/资源）" },
      { key: "taboo_rule", label: "底线规则", placeholder: "这个世界绝不越过的规则" },
    ],
  },
  {
    key: "geography",
    title: "地理",
    layer: "geography",
    intro: "故事发生的舞台：核心区域与它的性格。",
    type: "location",
    nameField: "region_name",
    fields: [
      { key: "region_name", label: "核心区域名称", required: true, placeholder: "如：东荒·青云山脉" },
      { key: "features", label: "地理特征", placeholder: "地形、气候、标志物" },
      { key: "story_role", label: "与故事的关系", placeholder: "主角从哪里出发？冲突在哪里发生？" },
    ],
  },
  {
    key: "ecology",
    title: "生态",
    layer: "ecology",
    intro: "物种与生态（现实向世界可跳过）。",
    type: "species",
    nameField: "species_name",
    fields: [
      { key: "species_name", label: "代表物种 / 生态特色", required: true, placeholder: "如：灵鹤、地火蟒" },
      { key: "traits", label: "特征与习性", placeholder: "栖息地、能力、危险度" },
      { key: "civilization_link", label: "与文明的关系", placeholder: "被驯养 / 被崇拜 / 是灾祸" },
    ],
  },
  {
    key: "eras",
    title: "历史",
    layer: "eras",
    intro: "纪元与历史的遗留问题（很多冲突的根）。",
    type: "lore",
    nameField: "era_name",
    fields: [
      { key: "era_name", label: "纪元 / 时代名称", required: true, placeholder: "如：灵潮纪元" },
      { key: "great_events", label: "大事件", placeholder: "改变了世界格局的事件" },
      { key: "legacy_issues", label: "遗留问题", placeholder: "至今未解的仇恨 / 封印 / 债务" },
    ],
  },
  {
    key: "civilizations",
    title: "文明",
    layer: "civilizations",
    intro: "文明、政体与信仰的组织方式。",
    type: "lore",
    nameField: "civilization_name",
    fields: [
      { key: "civilization_name", label: "文明 / 政体名称", required: true, placeholder: "如：大夏王朝" },
      { key: "culture", label: "文化特征", placeholder: "礼俗、审美、禁忌" },
      { key: "religion", label: "宗教与信仰", placeholder: "信什么？谁掌握解释权？" },
    ],
  },
  {
    key: "factions",
    title: "社会",
    layer: "factions",
    intro: "当前格局中的核心势力与它们的立场。",
    type: "faction",
    nameField: "faction_name",
    fields: [
      { key: "faction_name", label: "核心势力名称", required: true, placeholder: "如：青云宗" },
      { key: "stance", label: "与主角的关系", placeholder: "庇护 / 敌对 / 利用 / 观望" },
      { key: "resources", label: "资源与手段", placeholder: "势力靠什么立足" },
    ],
  },
  {
    key: "characters",
    title: "人物",
    layer: "characters",
    intro: "主角的初始处境：从哪来、靠什么、要什么。",
    type: "character",
    nameField: "protagonist_name",
    fields: [
      { key: "protagonist_name", label: "主角姓名", required: true, placeholder: "如：林渊" },
      { key: "background", label: "出身与处境", placeholder: "开局所处的位置" },
      { key: "golden_finger", label: "金手指 / 依仗", placeholder: "主角凭什么逆袭" },
      { key: "goal", label: "核心目标", placeholder: "他/她最想要什么" },
    ],
  },
  {
    key: "storylines",
    title: "故事",
    layer: "storylines",
    intro: "主线承诺与结局方向（后面大纲会展开）。",
    type: "lore",
    nameField: "logline",
    fields: [
      { key: "logline", label: "一句话主线", required: true, placeholder: "如：废柴少年得系统，踏碎山河问鼎九州" },
      { key: "promise", label: "对读者的总承诺", placeholder: "读者跟到结尾能得到什么" },
      { key: "ending", label: "结局方向", placeholder: "登顶 / 归隐 / 守护 / 变换世界" },
    ],
  },
];

export function buildCardBody(step: GenesisStep, values: Record<string, string>): string {
  const lines = step.fields.map(
    (field) => `- **${field.label}**：${values[field.key]?.trim() || "（待补充）"}`,
  );
  return `## 问卷回答\n\n${lines.join("\n")}\n`;
}