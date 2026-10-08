import type { ProofreadFinding } from "./types.js";

/**
 * 繁简转换（`proofread-conversion-ambiguous`，J14 §2.2 / §3.2）。
 *
 * **为什么不"一键转完"**：OpenCC 明确「严格区分一简对多繁与一简对多异」——
 * 「发」可能是「髮」（头发）也可能是「發」（出发），「干」可能是「乾」「幹」或本就是「干」。
 * 字面无法判定的条目一旦自动改写，就是把猜测写进作者正文（红线）。
 * 因此本模块的实现约束是：**歧义字一律原样保留、只登记候选**；
 * 反方向（繁→简）是多繁对一简，信息不丢失，可安全转换。
 *
 * 词表为**内置常用子集**（离线、零下载、无外部词典依赖），不是 OpenCC 全集：
 * 覆盖网文常用字，未收录的字原样返回。要接 OpenCC 全量数据时替换这两张表即可，
 * 判定与结果结构不变。
 */

/** 一简对多繁 / 一简对多异条目（候选顺序即面板呈现顺序，固定不随 locale 变） */
export interface TraditionalAmbiguousEntry {
  /** 简体（或两岸同形的多异字） */
  char: string;
  /** 候选繁体写法（≥2，按常用度排列） */
  candidates: readonly string[];
  /** 各候选的语义区分（写进 evidence，让作者能判） */
  gloss: string;
}

export const TRADITIONAL_AMBIGUOUS: readonly TraditionalAmbiguousEntry[] = [
  { char: "发", candidates: ["發", "髮"], gloss: "發（出發、發展）／髮（頭髮、理髮）" },
  { char: "后", candidates: ["後", "后"], gloss: "後（前後、後來）／后（皇后）" },
  { char: "干", candidates: ["乾", "幹", "干"], gloss: "乾（乾燥）／幹（幹部的幹）／干（天干、干戈）" },
  { char: "里", candidates: ["裡", "裏", "里"], gloss: "裡／裏（裡面）／里（里程、乡里）" },
  { char: "面", candidates: ["面", "麵"], gloss: "面（面對）／麵（麵條、擀麵）" },
  { char: "谷", candidates: ["谷", "穀"], gloss: "谷（山谷）／穀（五穀、稻穀）" },
  { char: "钟", candidates: ["鐘", "鍾"], gloss: "鐘（時鐘、鐘聲）／鍾（鍾情、姓氏）" },
  { char: "折", candidates: ["折", "摺"], gloss: "折（打折、曲折）／摺（摺叠、奏摺）" },
  { char: "台", candidates: ["台", "臺", "檯", "颱"], gloss: "台（台甫）／臺（舞臺）／檯（桌檯）／颱（颱風）" },
  { char: "余", candidates: ["余", "餘"], gloss: "余（文言自称）／餘（剩餘、其餘）" },
];

/** 无歧义的简→繁常用映射（网文高频字子集；未收录者原样返回） */
const S2T: readonly [string, string][] = [
  ["剑", "劍"],
  ["龙", "龍"],
  ["门", "門"],
  ["书", "書"],
  ["风", "風"],
  ["云", "雲"],
  ["马", "馬"],
  ["车", "車"],
  ["声", "聲"],
  ["处", "處"],
  ["让", "讓"],
  ["们", "們"],
  ["来", "來"],
  ["实", "實"],
  ["战", "戰"],
  ["学", "學"],
  ["气", "氣"],
  ["丝", "絲"],
  ["乱", "亂"],
  ["产", "產"],
  ["亲", "親"],
  ["从", "從"],
  ["仪", "儀"],
  ["优", "優"],
  ["会", "會"],
  ["伞", "傘"],
  ["伟", "偉"],
  ["传", "傳"],
  ["伤", "傷"],
  ["党", "黨"],
  ["关", "關"],
  ["兴", "興"],
  ["养", "養"],
  ["兽", "獸"],
  ["觉", "覺"],
  ["变", "變"],
  ["医", "醫"],
  ["压", "壓"],
  ["号", "號"],
  ["听", "聽"],
  ["启", "啟"],
  ["呢", "呢"],
  ["国", "國"],
  ["图", "圖"],
  ["夜", "夜"],
  ["头", "頭"],
  ["奖", "獎"],
  ["宪", "憲"],
  ["则", "則"],
  ["别", "別"],
  ["这", "這"],
  ["个", "個"],
  ["为", "為"],
  ["与", "與"],
  ["术", "術"],
  ["样", "樣"],
  ["话", "話"],
  ["语", "語"],
  ["说", "說"],
  ["读", "讀"],
  ["认", "認"],
  ["识", "識"],
  ["记", "記"],
  ["讲", "講"],
  ["许", "許"],
  ["论", "論"],
  ["议", "議"],
  ["贵", "貴"],
  ["购", "購"],
  ["圆", "圓"],
  ["团", "團"],
  ["园", "園"],
  ["叶", "葉"],
  ["敌", "敵"],
  ["数", "數"],
  ["时", "時"],
  ["晓", "曉"],
  ["显", "顯"],
  ["断", "斷"],
];

/** 简→繁查表（一次构建；歧义字不进这张表） */
const S2T_MAP = new Map<string, string>(S2T);

/** 歧义字 → 条目（一次构建，扫描时 O(1) 查表） */
const AMBIGUOUS_BY_CHAR = new Map(TRADITIONAL_AMBIGUOUS.map((entry) => [entry.char, entry]));

/**
 * 繁→简映射：无歧义表的反向 + 各歧义条目的全部候选归一到简体。
 * （多繁对一简不丢信息，可安全转换。）
 */
const T2S = new Map<string, string>([
  ...S2T.map(([simple, traditional]) => [traditional, simple] as [string, string]),
  ...TRADITIONAL_AMBIGUOUS.flatMap(
    (entry) => entry.candidates.map((c) => [c, entry.char] as [string, string]),
  ),
]);

/** 简→繁（歧义字原样保留并逐条登记候选） */
export interface TraditionalConversionResult {
  text: string;
  ambiguous: Array<{ start: number; end: number; char: string; candidates: readonly string[]; gloss: string }>;
}

export function toTraditional(text: string): TraditionalConversionResult {
  const ambiguous: TraditionalConversionResult["ambiguous"] = [];
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const entry = AMBIGUOUS_BY_CHAR.get(char);
    if (entry) {
      // 不猜：原样保留，只登记「此处需要作者确认」
      out += char;
      ambiguous.push({
        start: i,
        end: i + 1,
        char,
        candidates: entry.candidates,
        gloss: entry.gloss,
      });
      continue;
    }
    out += S2T_MAP.get(char) ?? char;
  }
  return { text: out, ambiguous };
}

/** 繁→简（多繁对一简，安全） */
export function toSimplified(text: string): string {
  let out = "";
  for (const char of text) out += T2S.get(char) ?? char;
  return out;
}

/**
 * 把歧义点转成检测结果：`info` 级、**autofix=false**（不确认就不改）。
 * `direction: "t2s"` 恒零命中——繁→简不存在需要作者选择的歧义。
 */
export function checkConversion(
  text: string,
  options: { chapter?: string; direction?: "s2t" | "t2s" } = {},
): ProofreadFinding[] {
  if (text === "" || options.direction === "t2s") return [];
  return toTraditional(text).ambiguous.map((hit) => ({
    rule: "proofread-conversion-ambiguous" as const,
    severity: "info" as const,
    span: {
      ...(options.chapter === undefined ? {} : { chapter: options.chapter }),
      start: hit.start,
      end: hit.end,
      text: hit.char,
    },
    suggestion: `候选：${hit.candidates.join(" / ")}`,
    candidates: hit.candidates,
    evidence: `「${hit.char}」一简对多繁／多异（${hit.gloss}）：字面无法判定，未自动改写，需作者选定`,
    autofix: false,
    source: { engine: "lexicon:conversion", conf: 1 },
  }));
}
