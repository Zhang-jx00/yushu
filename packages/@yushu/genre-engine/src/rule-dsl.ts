import { parse as parseYaml } from "yaml";
import { YushuError } from "@yushu/core";

/**
 * 规则 DSL 求值层（M4 / T4-1，承接 docs/03 §8.2 与 G06 §3）。
 *
 * 边界：本文件只负责「一条规则怎么解析、怎么求值」；规则**从哪来、比对什么数据**属 T4-2，
 * 报告形状与白名单属 T4-3，求值时机属 T4-4。引擎与流派解耦——规则本体由派系包注入。
 *
 * 沙箱四道闸门（G06 §3「表达式禁循环禁 IO，求值超时 + 递归深度上限」）：
 * 1. **操作符白名单**：未知操作符直接报错，不静默当假——"静默当假"会让规则永远不响，
 *    而"永不报警"看起来和"一切正常"在面板上一模一样，是最坏的失败方式。
 * 2. **禁循环**：本子集不实现任何迭代原语（map / reduce / merge / filter 一律拒绝）；
 *    唯一的遍历是 `in` 对固定数组的成员检查，其长度计入节点预算。
 * 3. **递归深度上限** `RULE_MAX_DEPTH`：解析期就拒绝过深的表达式（加载即失败，不留到跑一半才炸）。
 * 4. **求值预算** `RULE_MAX_NODES`：**用节点计数代替墙钟超时**——`Date.now()` 式的超时会让
 *    同一输入在慢机器上报错、快机器上通过，直接破坏本项目「同输入同输出」的确定性红线。
 *
 * 另外两条纪律：
 * - **禁 IO**：求值只读调用方传进来的 `data`，不碰 fs / 网络 / env；`var` 取不到函数、
 *   不越过原型链（`__proto__` / `constructor` 一类段名一律拒绝）。
 * - **不比字符串字典序**：大小比较只接受有限数字。中文字符串比大小必然要碰 `localeCompare`
 *   或平台相关排序，跨机器不稳定（项目红线：码点比较或干脆不比）。
 */

/** 与 T3-13 中文校对同为三级，**注意是 `warn` 不是 `warning`** */
export const RULE_SEVERITIES = ["error", "warn", "info"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

/** 规则作用域（决定 T4-3 报告按什么粒度聚合） */
export const RULE_SCOPES = ["scene", "chapter", "cross_chapter", "project"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/** 表达式嵌套上限：正常规则不会到两位数，超限多半是写错或在试探沙箱 */
export const RULE_MAX_DEPTH = 16;

/** 一次求值的节点预算（含 `in` 数组的逐元素计数） */
export const RULE_MAX_NODES = 2000;

/** 二元比较（两侧都必须是有限数字） */
const ORDER_OPS = [">", ">=", "<", "<="] as const;
/** 严格等值（本子集不提供隐式类型转换） */
const EQUALITY_OPS = ["==", "!="] as const;
const ARITH_OPS = ["+", "-", "*", "/"] as const;
const ALL_OPERATORS = new Set<string>([
  "var",
  "and",
  "or",
  "!",
  ...ORDER_OPS,
  ...EQUALITY_OPS,
  "in",
  ...ARITH_OPS,
]);

/** 明确点名的禁止原语：让"为什么不能用"出现在错误信息里，而不是笼统的未知操作符 */
const FORBIDDEN_OPERATORS: Record<string, string> = {
  reduce: "禁循环：迭代原语一律不实现（数据侧请先把结论算好再交给规则）",
  map: "禁循环：迭代原语一律不实现",
  filter: "禁循环：迭代原语一律不实现",
  merge: "禁循环：合并类原语属数据处理，不属规则求值",
  each: "禁循环：迭代原语一律不实现",
  some: "禁循环：需要存在性判断请用 in 对固定数组做成员检查",
  every: "禁循环：同上",
  cat: "禁拼接：字符串拼接属报告渲染，请用 message 模板的 {占位}",
  concat: "禁拼接：同上",
  regex: "禁正则：模式匹配属 T4-2 的检测器，不属布尔求值",
  pattern: "禁正则：同上",
  fetch: "禁 IO：求值不得访问网络",
  fs: "禁 IO：求值不得读写文件",
  env: "禁 IO：求值不得读环境变量",
  now: "禁时间：求值不得读时钟（同输入必须同输出）",
  date: "禁时间：同上",
};

/** `var` 路径里绝不允许出现的段（原型链与构造器逃逸面） */
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export class RuleDslError extends YushuError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

/** 条件表达式（JSONLogic 子集的 AST；结构由 `parseRuleDocument` 校验后才算合法） */
export type RuleExpr = unknown;

export interface ConsistencyRule {
  id: string;
  severity: RuleSeverity;
  scope: RuleScope;
  when: RuleExpr;
  /** 结论文案，可含 `{a.chapter}` 形式的占位（点分路径，与 var 同一套取数规则） */
  message: string;
  /** 融合冲突消解排序用（G06 §5：同目标矛盾时按 severity + priority 排序并弹确认）；未写即参与排序时按 0 */
  priority?: number;
  /** 出处（规则件信封带来：集 id / 标题 / 调研来源）；单条 `rule:` 形状没有 */
  origin?: RuleOrigin;
}

export interface RuleEvaluation {
  ruleId: string;
  severity: RuleSeverity;
  scope: RuleScope;
  matched: boolean;
  /** 渲染后的结论（未命中时同样给出，面板要能回答"为什么不报"） */
  message: string;
  /** 求值期间读到的 var 路径与取到的值——每条结论都要能说出依据（J14 的可解释性同一条线） */
  evidence: Record<string, string>;
}

const RULE_KEYS = ["id", "severity", "scope", "when", "message", "priority"] as const;

/** 规则件的信封版本（与 llm / routing / budget 同一套「版本必填、未知键拒绝」约定） */
export const RULE_SET_API_VERSION = "yushu.rules/v1";
const SET_KEYS = ["apiVersion", "id", "title", "source", "rules"] as const;

/** 规则集信封的出处信息（`source` 指向 D03 / D07 这类调研条目） */
export interface RuleOrigin {
  set: string;
  title?: string;
  source?: string;
}

/**
 * 解析规则文件。两种形状都收，但口径不同：
 * - **规则件**（派系包里的 `rules/*.yaml`）：`apiVersion: yushu.rules/v1` + `id / title / source` + `rules:` 列表，
 *   版本必填、未知键拒绝——真实包就是这个形状（`packs/xuanhuan-xitong/rules/`）；
 * - **单条规则**（docs/03 §8.2 的示例形状）：顶层 `rule:`，不带版本。
 * 列表**必须**走版本化信封：没有 `apiVersion` 的一批规则无法判断按哪套语义求值。
 */
export function parseRuleDocument(text: string): ConsistencyRule[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new RuleDslError(
      "E_RULE_PARSE",
      `规则文件无法解析：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleDslError("E_RULE_PARSE", "规则文件顶层应为映射（rule: 或 apiVersion + rules:）");
  }
  const record = raw as Record<string, unknown>;
  if (record["apiVersion"] !== undefined) return parseRuleSet(record);
  const unknownTop = Object.keys(record).filter((key) => key !== "rule");
  if (unknownTop.length > 0) {
    throw new RuleDslError(
      "E_RULE_PARSE",
      `规则文件含未知顶层键「${unknownTop.join("、")}」（规则列表需带 apiVersion: ${RULE_SET_API_VERSION}）`,
    );
  }
  const single = record["rule"];
  if (single === undefined) throw new RuleDslError("E_RULE_PARSE", "规则文件缺少 rule 或 apiVersion + rules");
  return [parseOneRule(single)];
}

/** 规则件信封：逐条解析并盖上出处；**出处字段不得静默丢弃**（丢了就等于抹掉规则的可追溯性） */
function parseRuleSet(record: Record<string, unknown>): ConsistencyRule[] {
  for (const key of Object.keys(record)) {
    if (!(SET_KEYS as readonly string[]).includes(key)) {
      throw new RuleDslError("E_RULE_PARSE", `规则件含未知顶层键「${key}」（拒绝静默忽略）`);
    }
  }
  if (record["apiVersion"] !== RULE_SET_API_VERSION) {
    throw new RuleDslError("E_RULE_PARSE", `规则件 apiVersion 应为 ${RULE_SET_API_VERSION}`);
  }
  const setId = record["id"];
  if (typeof setId !== "string" || setId.trim() === "") {
    throw new RuleDslError("E_RULE_PARSE", "规则件的 id 应为非空字符串（命名空间前缀）");
  }
  const title = record["title"];
  const source = record["source"];
  for (const [field, value] of [["title", title], ["source", source]] as const) {
    if (value !== undefined && typeof value !== "string") throw new RuleDslError("E_RULE_PARSE", `规则件的 ${field} 应为字符串`);
  }
  const list = record["rules"];
  if (!Array.isArray(list) || list.length === 0) {
    throw new RuleDslError("E_RULE_PARSE", "规则件的 rules 应为非空数组");
  }
  const origin: RuleOrigin = {
    set: setId,
    ...(typeof title === "string" && title.trim() !== "" ? { title } : {}),
    ...(typeof source === "string" && source.trim() !== "" ? { source } : {}),
  };
  const rules = list.map((item, index) => parseOneRule(item, `rules[${index}]`));
  for (const rule of rules) rule.origin = origin;
  assertUniqueIds(rules);
  return rules;
}

function assertUniqueIds(rules: ConsistencyRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      // 同 id 覆盖必须走显式的版本合并（G06：同 id 高版本胜出），文件内重复是写错
      throw new RuleDslError("E_RULE_PARSE", `同一文件内规则 id 重复「${rule.id}」（跨文件覆盖请交给版本合并）`);
    }
    seen.add(rule.id);
  }
}

function parseOneRule(value: unknown, where = "rule"): ConsistencyRule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuleDslError("E_RULE_PARSE", `${where} 应为映射`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(RULE_KEYS as readonly string[]).includes(key)) {
      throw new RuleDslError("E_RULE_PARSE", `${where} 含未知键「${key}」（拒绝静默忽略：拼错的键会让规则以为少了一个条件）`);
    }
  }
  const id = record["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new RuleDslError("E_RULE_PARSE", `${where}.id 应为非空字符串`);
  }
  const severity = record["severity"];
  if (typeof severity !== "string" || !(RULE_SEVERITIES as readonly string[]).includes(severity)) {
    throw new RuleDslError("E_RULE_PARSE", `${where}.severity 应为 ${RULE_SEVERITIES.join(" | ")}（不是 warning）`);
  }
  const scope = record["scope"];
  if (typeof scope !== "string" || !(RULE_SCOPES as readonly string[]).includes(scope)) {
    throw new RuleDslError("E_RULE_PARSE", `${where}.scope 应为 ${RULE_SCOPES.join(" | ")}`);
  }
  const when = record["when"];
  if (when === null || typeof when !== "object") {
    throw new RuleDslError("E_RULE_PARSE", `${where}.when 应为操作符对象（不是标量）`);
  }
  if (Array.isArray(when)) {
    throw new RuleDslError("E_RULE_PARSE", `${where}.when 应为 {"操作符": 参数}，不是裸数组`);
  }
  const message = record["message"];
  if (typeof message !== "string" || message.trim() === "") {
    throw new RuleDslError("E_RULE_PARSE", `${where}.message 应为非空字符串（无结论的规则不给过）`);
  }
  const priorityValue = record["priority"];
  if (priorityValue !== undefined && (!Number.isInteger(priorityValue) || (priorityValue as number) < 0)) {
    throw new RuleDslError("E_RULE_PARSE", `${where}.priority 应为非负整数`);
  }
  const depth = measureDepth(when, 1);
  if (depth > RULE_MAX_DEPTH) {
    throw new RuleDslError(
      "E_RULE_DEPTH",
      `${id} 的表达式嵌套 ${depth} 层，超过上限 ${RULE_MAX_DEPTH}：加载期即拒绝，不留到求值跑一半才失败`,
    );
  }
  return {
    id,
    severity: severity as RuleSeverity,
    scope: scope as RuleScope,
    when,
    message,
    ...(priorityValue === undefined ? {} : { priority: priorityValue as number }),
  };
}

function measureDepth(node: unknown, current: number): number {
  if (current > RULE_MAX_DEPTH + 1) return current; // 已超限，停止深入（避免自身递归爆栈）
  if (Array.isArray(node)) {
    let max = current;
    for (const item of node) max = Math.max(max, measureDepth(item, current + 1));
    return max;
  }
  if (node !== null && typeof node === "object") {
    let max = current;
    for (const value of Object.values(node)) max = Math.max(max, measureDepth(value, current + 1));
    return max;
  }
  return current;
}

/**
 * 求值一条规则。`data` 是调用方备好的比对上下文（如 `{a: {...}, b: {...}}`），
 * 求值过程**不写回 data、不产生副作用**。
 */
export function evaluateRule(rule: ConsistencyRule, data: Record<string, unknown>): RuleEvaluation {
  const ctx: EvalContext = { data, evidence: {}, nodes: 0 };
  const matched = truthy(evalNode(rule.when, ctx, 1));
  return {
    ruleId: rule.id,
    severity: rule.severity,
    scope: rule.scope,
    matched,
    message: renderMessage(rule.message, ctx.evidence, data),
    evidence: ctx.evidence,
  };
}

interface EvalContext {
  data: Record<string, unknown>;
  evidence: Record<string, string>;
  nodes: number;
}

function evalNode(node: unknown, ctx: EvalContext, depth: number): unknown {
  ctx.nodes += 1;
  if (ctx.nodes > RULE_MAX_NODES) {
    throw new RuleDslError(
      "E_RULE_BUDGET",
      `求值节点数超过预算 ${RULE_MAX_NODES}：表达式或数据规模异常（沙箱按节点计数中断，不用墙钟计时）`,
    );
  }
  if (depth > RULE_MAX_DEPTH) {
    throw new RuleDslError("E_RULE_DEPTH", `求值嵌套超过 ${RULE_MAX_DEPTH} 层`);
  }
  if (node === null || typeof node !== "object") return node; // 字面量
  if (Array.isArray(node)) {
    throw new RuleDslError("E_RULE_OPERATOR", "裸数组只能作为操作符的参数出现，不能独立求值");
  }
  const keys = Object.keys(node);
  if (keys.length !== 1) {
    throw new RuleDslError(
      "E_RULE_OPERATOR",
      `表达式对象必须只含一个操作符键，实际有 ${keys.length} 个（${keys.join("、")}）`,
    );
  }
  const operator = keys[0]!;
  const operand = (node as Record<string, unknown>)[operator];
  if (!ALL_OPERATORS.has(operator)) {
    const hint = FORBIDDEN_OPERATORS[operator];
    throw new RuleDslError(
      "E_RULE_OPERATOR",
      `未知操作符「${operator}」${hint ? `：${hint}` : "：白名单之外的操作符一律拒绝，不静默当假（静默当假＝规则永不响）"}`,
    );
  }
  switch (operator) {
    case "var":
      return readVar(operand, ctx);
    case "and": {
      const items = requireArray(operator, operand);
      for (const item of items) {
        if (!truthy(evalNode(item, ctx, depth + 1))) return false;
      }
      return true;
    }
    case "or": {
      const items = requireArray(operator, operand);
      for (const item of items) {
        if (truthy(evalNode(item, ctx, depth + 1))) return true;
      }
      return false;
    }
    case "!":
      return !truthy(evalNode(operand, ctx, depth + 1));
    case "in": {
      const [needleValue, haystackValue] = requireArgs(operator, operand, 2);
      const needle = evalNode(needleValue, ctx, depth + 1);
      const haystack = readCandidateList(haystackValue, ctx, depth);
      if (Array.isArray(haystack)) {
        ctx.nodes += haystack.length; // 成员检查是唯一的遍历：长度计入预算
        if (ctx.nodes > RULE_MAX_NODES) {
          throw new RuleDslError("E_RULE_BUDGET", `in 的候选数组把节点预算用完（上限 ${RULE_MAX_NODES}）`);
        }
        return haystack.some((item) => sameValue(item, needle));
      }
      if (typeof haystack === "string" && typeof needle === "string") {
        return needle !== "" && haystack.includes(needle);
      }
      throw new RuleDslError("E_RULE_OPERATOR", "in 的第二个参数必须是数组或字符串");
    }
    case "==":
    case "!=": {
      const [left, right] = requireArgs(operator, operand, 2);
      const equal = sameValue(evalNode(left, ctx, depth + 1), evalNode(right, ctx, depth + 1));
      return operator === "==" ? equal : !equal;
    }
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const [left, right] = requireArgs(operator, operand, 2);
      const a = expectNumber(operator, evalNode(left, ctx, depth + 1), "左");
      const b = expectNumber(operator, evalNode(right, ctx, depth + 1), "右");
      switch (operator) {
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        case "<":
          return a < b;
        default:
          return a <= b;
      }
    }
    case "+":
    case "*": {
      const items = requireArray(operator, operand);
      if (items.length < 2) throw new RuleDslError("E_RULE_OPERATOR", `${operator} 至少需要 2 个参数`);
      const values = items.map((item) => expectNumber(operator, evalNode(item, ctx, depth + 1), "操作数"));
      // 单位元不能共用 0：乘法从 0 起步会恒为 0
      return operator === "+" ? values.reduce((sum, value) => sum + value, 0) : values.reduce((product, value) => product * value, 1);
    }
    case "-":
    case "/": {
      const [left, right] = requireArgs(operator, operand, 2);
      const a = expectNumber(operator, evalNode(left, ctx, depth + 1), "左");
      const b = expectNumber(operator, evalNode(right, ctx, depth + 1), "右");
      if (operator === "/" && b === 0) {
        // 战力比值「除以 0」多半是数据缺位，返回 Infinity 会让下一条比较静默失真
        throw new RuleDslError("E_RULE_DIV_ZERO", "除数为 0：比值类规则请确保分母存在且非零");
      }
      return operator === "/" ? a / b : a - b;
    }
    default:
      throw new RuleDslError("E_RULE_OPERATOR", `操作符「${operator}」未实现`);
  }
}

/**
 * `in` 的候选侧取法（与其它操作数不同，故单列）：
 * - 数组 → **字面量候选清单**（`["爽文","黑深残"]` 这类枚举是规则里最常见的写法），
 *   元素一律按字面值比较、**不递归求值**——否则「禁循环」的边界会随规则写法浮动；
 * - 对象 → 当表达式求值（通常是 `{var: "aliases"}`，候选清单存在数据侧）；
 * - 标量 → 原样返回，交由上层报「必须是数组或字符串」。
 */
function readCandidateList(operand: unknown, ctx: EvalContext, depth: number): unknown {
  if (Array.isArray(operand)) return operand;
  if (operand !== null && typeof operand === "object") return evalNode(operand, ctx, depth + 1);
  return operand;
}

function requireArray(operator: string, operand: unknown): unknown[] {
  if (!Array.isArray(operand)) {
    throw new RuleDslError("E_RULE_OPERATOR", `${operator} 的参数应为数组`);
  }
  return operand;
}

function requireArgs(operator: string, operand: unknown, arity: number): [unknown, unknown] {
  if (!Array.isArray(operand) || operand.length !== arity) {
    throw new RuleDslError("E_RULE_OPERATOR", `${operator} 需要恰好 ${arity} 个参数`);
  }
  return [operand[0], operand[1]];
}

function expectNumber(operator: string, value: unknown, side: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuleDslError(
      "E_RULE_UNORDERABLE",
      `${operator} 的${side}侧不是有限数字（实际 ${describeValue(value)}）：大小比较只接受数字，不比字符串字典序`,
    );
  }
  return value;
}

/** 严格等值：不做隐式转换（"0" 与 0 不相等），null / undefined 视为两种"没有" */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined) return right === null || right === undefined;
  return false;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value) || (value !== null && typeof value === "object")) return true;
  return Boolean(value);
}

function readVar(operand: unknown, ctx: EvalContext): unknown {
  if (typeof operand !== "string" || operand.trim() === "") {
    throw new RuleDslError("E_RULE_VAR", `var 的参数应为点分路径字符串（实际 ${describeValue(operand)}）`);
  }
  const value = readPath(ctx.data, operand);
  // 记下读到的值：结论要能追溯到依据，缺字段也要看得见
  ctx.evidence[operand] = describeValue(value);
  return value;
}

/**
 * 点分路径取值：数组段用数字下标（`items.0.name`）。
 * 只做纯读取——不越过原型链、不调用函数、不解析表达式。
 */
export function readPath(root: unknown, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = root;
  for (const segment of segments) {
    if (segment === "") {
      throw new RuleDslError("E_RULE_VAR", `路径「${path}」含空段`);
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new RuleDslError("E_RULE_VAR", `路径「${path}」尝试读取「${segment}」：原型链与构造器一律拒绝`);
    }
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") {
      throw new RuleDslError("E_RULE_VAR", `路径「${path}」在「${segment}」处不是对象或数组，无法继续取值`);
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    const record = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
    const next = record[segment];
    if (typeof next === "function") {
      throw new RuleDslError("E_RULE_VAR", `路径「${path}」指向函数：求值不得调用任何函数`);
    }
    cursor = next;
  }
  return cursor;
}

/**
 * 把 var 值文本化，同时作为 evidence 的展示口径。
 * 复合值只说"是什么、多大"，不展开内容——展开会把整段正文塞进面板。
 */
function describeValue(value: unknown): string {
  if (value === undefined) return "（缺失）";
  if (value === null) return "（空值）";
  if (typeof value === "string") return value === "" ? "（空字符串）" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `（数组 ${value.length} 项）`;
  return "（对象）";
}

/**
 * 渲染结论模板：`{a.chapter}` 用同一套安全路径取数。
 * 取不到时留「（缺 路径）」而不是抛错——规则命中了却因为文案取不到而整体失败，
 * 等于把一条真问题从报告里抹掉。
 */
export function renderMessage(template: string, evidence: Record<string, string>, data: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$0-9]+)*)\}/g, (_match, path: string) => {
    if (Object.prototype.hasOwnProperty.call(evidence, path)) return evidence[path]!;
    const value = readPathSafe(data, path);
    return value === undefined ? `（缺 ${path}）` : describeValue(value);
  });
}

function readPathSafe(root: unknown, path: string): unknown {
  try {
    return readPath(root, path);
  } catch {
    return undefined;
  }
}
