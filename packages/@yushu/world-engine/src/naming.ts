import { YushuError } from "@yushu/core";

/**
 * 命名生成器（T1-8 最小版）：每文化一套「音位池（字库）+ 构词模式」+ 随机种子。
 * - 种子确定 → 结果确定（可复现、可测试）；缺省种子 = 时间戳（每次换一批）；
 * - 内置三套文化规则（仙侠 / 西幻 / 现代都市），按世界维度自动选择；
 * - M1 为本地无 AI 能力（离线可用）；M3 的 AI 取名助手与 M5 派系包自定义字库在其上叠加。
 */

export const NAMING_API_VERSION = "yushu.naming/v1" as const;

/** 命名对象类型：角色 / 地名 / 门派 / 功法 */
export type NamingKind = "character" | "place" | "sect" | "technique";

export const NAMING_KINDS: readonly { kind: NamingKind; label: string }[] = [
  { kind: "character", label: "角色名" },
  { kind: "place", label: "地名" },
  { kind: "sect", label: "门派" },
  { kind: "technique", label: "功法" },
] as const;

export interface NamingRules {
  apiVersion: typeof NAMING_API_VERSION;
  id: string;
  title: string;
  /** 构词模式说明（供 UI 与作者理解该文化的命名习惯） */
  pattern: string;
  surnames: string[];
  /** 名的用字（音位池） */
  givenChars: string[];
  placePrefixes: string[];
  placeSuffixes: string[];
  sectPrefixes: string[];
  sectSuffixes: string[];
  techniquePrefixes: string[];
  techniqueSuffixes: string[];
}

export class NamingError extends YushuError {
  constructor(message: string) {
    super("E_NAMING", message);
  }
}

/** 仙侠 / 玄幻：单姓 + 单双名；地名取"景+形"；门派"势+制"；功法"象+体" */
const XIANXIA: NamingRules = {
  apiVersion: NAMING_API_VERSION,
  id: "xianxia",
  title: "仙侠玄幻",
  pattern: "姓（单字）+ 名（1-2 字）｜地名=景+形｜门派=势+制｜功法=象+体",
  surnames: ["林", "叶", "萧", "楚", "顾", "陆", "苏", "沈", "秦", "姜", "谢", "韩"],
  givenChars: ["渊", "尘", "玄", "澈", "辰", "岚", "汐", "瑶", "璃", "彦", "岳", "霄", "烬", "白", "青", "慕"],
  placePrefixes: ["青", "云", "幽", "玄", "紫", "落", "寒", "九", "苍", "赤"],
  placeSuffixes: ["峰", "城", "谷", "渊", "州", "海", "原", "岭"],
  sectPrefixes: ["天", "太", "玄", "青", "焚", "万", "九", "归"],
  sectSuffixes: ["宗", "门", "阁", "殿", "院", "观"],
  techniquePrefixes: ["焚", "御", "破", "紫", "太", "九", "裂", "噬"],
  techniqueSuffixes: ["诀", "经", "典", "术", "录", "图"],
};

/** 西幻：音译式姓名（音位拼接）；地名/门派/功法用"外文音译 + 汉语制式" */
const WESTERN: NamingRules = {
  apiVersion: NAMING_API_VERSION,
  id: "western",
  title: "西幻",
  pattern: "名（2-3 音位拼合）+ 姓（2 音位）｜地名=音译+地形｜门派=音译+建制｜奥义=音译+秘典",
  surnames: ["艾尔", "凯恩", "洛林", "塞德", "奥文", "米拉", "德文", "瓦尔"],
  givenChars: ["艾", "琳", "娜", "罗", "恩", "斯", "特", "薇", "兰", "德", "尔", "文", "塞", "洛"],
  placePrefixes: ["银", "暮", "灰", "龙", "霜", "星", "铁", "雾"],
  placeSuffixes: ["港", "堡", "森林", "峡谷", "荒原", "要塞"],
  sectPrefixes: ["银", "圣", "黑", "龙", "影", "铁"],
  sectSuffixes: ["骑士团", "教团", "议会", "兄弟会", "结社"],
  techniquePrefixes: ["秘", "禁", "龙", "星", "血", "霜"],
  techniqueSuffixes: ["奥义", "秘典", "咒式", "祷文", "铭文"],
};

/** 现代都市：单姓 + 单双名（常用字） */
const MODERN: NamingRules = {
  apiVersion: NAMING_API_VERSION,
  id: "modern",
  title: "现代都市",
  pattern: "姓（单字）+ 名（1-2 字）｜地名=方位+通名｜门派=品牌+机构｜技术=术语+载体",
  surnames: ["陈", "李", "王", "周", "许", "何", "程", "江", "方", "唐", "钟", "夏"],
  givenChars: ["宇", "宁", "然", "一", "鸣", "川", "悦", "舟", "禾", "沐", "屹", "知", "遥", "叙", "呈", "澈"],
  placePrefixes: ["东", "西", "南", "北", "中", "临", "望", "滨"],
  placeSuffixes: ["江", "岸", "里", "街", "湾", "塔", "园", "巷"],
  sectPrefixes: ["星", "华", "联合", "恒", "远", "综合"],
  sectSuffixes: ["集团", "事务所", "研究院", "调查局", "财团", "工作室"],
  techniquePrefixes: ["神经", "认知", "量子", "深潜", "线索", "协议"],
  techniqueSuffixes: ["网络", "接口", "协议", "工法", "框架"],
};

export const BUILTIN_NAMING_RULES: readonly NamingRules[] = [XIANXIA, WESTERN, MODERN] as const;

export function getNamingRules(id: string): NamingRules | null {
  return BUILTIN_NAMING_RULES.find((rules) => rules.id === id) ?? null;
}

/** 世界维度 → 命名规则（未知维度兜底仙侠，保证离线总能生成） */
export function namingRulesForWorld(worldAxes: string[]): NamingRules {
  const joined = worldAxes.join(" ");
  if (/西幻|异界|蒸汽|克苏鲁|奇幻/.test(joined)) return WESTERN;
  if (/现实都市|都市|现代|职场/.test(joined)) return MODERN;
  return XIANXIA;
}

/*
 * 确定性随机：djb2 派生种子 → mulberry32。
 * 同一 (rules, kind, seed) 永远得到同一批名字（可复现；测试与作者"找回上次那批名"都依赖它）。
 */
function hashSeed(seed: string): number {
  let hash = 5381;
  for (const ch of seed) {
    hash = ((hash << 5) + hash + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new NamingError("命名规则字库为空");
  return items[Math.floor(random() * items.length)]!;
}

function buildName(kind: NamingKind, rules: NamingRules, random: () => number): string {
  switch (kind) {
    case "character": {
      const surname = pick(random, rules.surnames);
      const length = random() < 0.65 ? 2 : 1;
      let given = "";
      for (let i = 0; i < length; i += 1) given += pick(random, rules.givenChars);
      return surname + given;
    }
    case "place":
      return pick(random, rules.placePrefixes) + pick(random, rules.placeSuffixes);
    case "sect":
      return pick(random, rules.sectPrefixes) + pick(random, rules.sectSuffixes);
    case "technique":
      return pick(random, rules.techniquePrefixes) + pick(random, rules.techniqueSuffixes);
    default:
      throw new NamingError(`未知命名类型：${String(kind)}`);
  }
}

export interface MakeNamesOptions {
  rules?: NamingRules | string;
  /** 显式种子（数字或字符串）；缺省用时间戳（每次换一批） */
  seed?: number | string;
  count?: number;
}

/** 生成一批去重名字（count 默认 5，上限 50） */
export function makeNames(kind: NamingKind, options: MakeNamesOptions = {}): string[] {
  const rules =
    typeof options.rules === "string"
      ? getNamingRules(options.rules)
      : (options.rules ?? XIANXIA);
  if (!rules) throw new NamingError(`未找到命名规则：${String(options.rules)}`);
  const count = Math.min(Math.max(options.count ?? 5, 1), 50);
  const seedText = `${rules.id}:${kind}:${options.seed ?? Date.now()}`;
  const random = mulberry32(hashSeed(seedText));

  const names = new Set<string>();
  // 去重：同批不重复（字库小/数量大时限制尝试次数，允许提前收敛）
  for (let attempt = 0; attempt < count * 20 && names.size < count; attempt += 1) {
    names.add(buildName(kind, rules, random));
  }
  return [...names];
}