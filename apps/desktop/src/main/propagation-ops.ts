import { join } from "node:path";
import {
  ProposalError,
  readCardFile,
  serializeCardFile,
  checkStructureFromSources,
  parseProposalFile,
  propagate,
  serializeProposal,
  type Proposal,
  type ProposalDecision,
  type ProposalFile,
} from "@yushu/world-engine";
import { gatewayReader } from "./index-ops.js";
import { takeSnapshot } from "./snapshot-ops.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 影响传播的桌面侧（M4 / T4-5，R61）：**提案生成 + 落派生目录 + 逐项决策**。
 *
 * 本轮刻意**不写回真源**——把"改一个上游字段会波及谁"算清楚、记下来、让人逐条表态，
 * 已经是有价值且安全的一截。写回（`applyProposal`）要动设定卡，必须与"改之前先快照 + 带 baseHash 拒覆盖"
 * 一起上，否则等于把"引擎替作者改数据"这件事提前开门。红线在这一轮的具体形态就是：
 * **跑完预览与决策，真源字节一个都不能变**。
 *
 * 落点 `.yushu/proposals/prop-<id>.yaml` 是**派生物**（与 ai-usage / context-log 同类）：
 * 不入 Git、不入索引、不进快照，删掉可重算。写盘一律走 FileGateway（原子写 + 并发检测）；
 * 只有列目录用 fs 读——`listTree` 明确排除 `.yushu/`，而这里读的就是那个派生区。
 * 格式与严格解析在引擎侧 `proposal-file.ts`（数据模型的事不跟着进程边界走）。
 */

export const PROPOSAL_DIR = ".yushu/proposals";

export interface ProposalListItem extends ProposalFile {
  path: string;
  /** 还没表态的条数：面板显示"还有 N 条没看"，将来写回那一步用它拒绝半成品 */
  undecidedCount: number;
}

export function proposalDirOf(gateway: ProjectGateway): string {
  return join(gateway.root, PROPOSAL_DIR);
}

export function proposalPathOf(id: string): string {
  return `${PROPOSAL_DIR}/prop-${id.replace(/^prop-/, "")}.yaml`;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 跑一次反向传播并把提案写进派生区。同一改动重复预览不堆文件（提案 id 由内容决定） */
export async function previewPropagation(
  gateway: ProjectGateway,
  change: { entity: string; field: string },
  options: { maxDepth?: number; weights?: Record<string, number>; now?: () => Date } = {},
): Promise<{ path: string; proposal: Proposal; file: ProposalFile }> {
  const structure = await checkStructureFromSources(gatewayReader(gateway));
  // propagate() 对不存在的实体抛错，这里因此**不写文件**——半份提案比没有提案更误导人
  const proposal = propagate(change, { entities: structure.entities, refs: structure.refs }, {
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.weights === undefined ? {} : { weights: options.weights }),
  });
  const path = proposalPathOf(proposal.proposalId);
  const stamp = (options.now ?? (() => new Date()))().toISOString();
  const existing = await gateway.readDoc(path).catch(() => null);
  const previous = existing === null ? null : parseProposalFile(path, existing.content);
  const file: ProposalFile = {
    proposal,
    decisions: previous?.decisions ?? {},
    applied: previous?.applied ?? [],
    sources: await sourceHashesOf(gateway, structure.entities, proposal.impact),
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  const text = serializeProposal(file);
  if (existing === null) {
    await gateway.writeDerived(path, text);
  } else if (existing.content !== text) {
    await gateway.writeDerived(path, text, existing.hash);
  }
  return { path, proposal, file };
}

/** 逐条表态：只改派生提案文件，真源不碰。blocked 提案没有可决策项，直接拒 */
export async function decideProposal(
  gateway: ProjectGateway,
  proposalId: string,
  index: number,
  decision: ProposalDecision,
  now: () => Date = () => new Date(),
): Promise<ProposalFile> {
  if (!["accept", "reject", "pending"].includes(decision)) {
    throw new ProposalError("E_PROPOSAL_DECISION", `decision 只能是 accept/reject/pending（收到「${String(decision)}」）`);
  }
  const path = proposalPathOf(proposalId);
  const snapshot = await gateway.readDoc(path).catch(() => null);
  if (snapshot === null) {
    throw new ProposalError("E_PROPOSAL_NOT_FOUND", `找不到提案 ${proposalId}（可能已被清理，重新做一次影响传播预览）`);
  }
  const file = parseProposalFile(path, snapshot.content);
  if (file.proposal.status === "blocked") {
    throw new ProposalError("E_PROPOSAL_BLOCKED", "这份提案被环阻断了，没有可决策项（先修掉成环的引用再传播）");
  }
  if (!Number.isInteger(index) || index < 0 || index >= file.proposal.impact.length) {
    throw new ProposalError(
      "E_PROPOSAL_INDEX",
      `条目下标越界：提案只有 ${file.proposal.impact.length} 条（0..${Math.max(0, file.proposal.impact.length - 1)}），收到 ${String(index)}`,
    );
  }
  file.decisions[String(index)] = decision;
  file.updatedAt = now().toISOString();
  await gateway.writeDerived(path, serializeProposal(file), snapshot.hash);
  return file;
}

/** 列出全部提案。任何一份读不了就整体报错，不静默少列——静默跳过等于"你的提案没了" */
export async function listProposals(gateway: ProjectGateway): Promise<ProposalListItem[]> {
  const names = (await gateway.listDerived(PROPOSAL_DIR)).filter((name) => name.endsWith(".yaml"));
  const out: ProposalListItem[] = [];
  for (const name of names) {
    const path = `${PROPOSAL_DIR}/${name}`;
    const doc = await gateway.readDoc(path);
    const file = parseProposalFile(path, doc.content);
    out.push({
      ...file,
      path,
      undecidedCount: file.proposal.impact.filter((_, index) => file.decisions[String(index)] === undefined).length,
    });
  }
  return out;
}

/** 只读"被点名的那几张卡"，取它们此刻的 hash 作为写回基线（不扫全库） */
async function sourceHashesOf(
  gateway: ProjectGateway,
  entities: ReadonlyArray<{ id: string; filePath: string }>,
  impact: ReadonlyArray<{ entity: string }>,
): Promise<Record<string, string>> {
  const filePathById = new Map(entities.map((entity) => [entity.id, entity.filePath]));
  const out: Record<string, string> = {};
  for (const row of impact) {
    if (out[row.entity] !== undefined) continue;
    const cardPath = filePathById.get(row.entity);
    if (cardPath === undefined) continue;
    out[row.entity] = (await gateway.readDoc(cardPath)).hash;
  }
  return out;
}

/**
 * 写回真源（R62）：**只做机械可确定的那一种编辑**——实体改名后，把已 accept 的那些卡里
 * `refs.target` 从旧 id 改指新 id。其余改动（改正文、改别名、改层级…）没有唯一正确的下游写法，
 * 一律拒绝并说明，让作者自己处理；引擎不替作者决定「这条设定该怎么改」。
 *
 * 四道闸按顺序生效，每道都对应一种真实伤害：
 * ① 全部条目已表态（否则「写回」会静默跳过没看过的那几条）；
 * ② 只认改名，且必须有 `to`；
 * ③ 写之前强制 `pre_apply_proposal` 快照，拿不到就阻断（撤销窗口必须在写之前存在）；
 * ④ 每张卡带读到的 hash 写（外部改过就冲突，不盲写）。
 */
export async function applyProposal(gateway: ProjectGateway, proposalId: string): Promise<ProposalFile> {
  const path = proposalPathOf(proposalId);
  const stored = await gateway.readDoc(path).catch(() => null);
  if (stored === null) {
    throw new ProposalError("E_PROPOSAL_NOT_FOUND", `找不到提案 ${proposalId}（可能已被清理）`);
  }
  const file = parseProposalFile(path, stored.content);
  const { proposal } = file;
  if (proposal.status === "blocked") {
    throw new ProposalError("E_PROPOSAL_BLOCKED", "这份提案被环阻断，没有可写回的条目");
  }
  if (proposal.status === "applied") {
    throw new ProposalError("E_PROPOSAL_APPLIED", "这份提案已经写回过了（要再改请重新生成提案，不重复应用）");
  }
  const undecided = proposal.impact.filter((_, index) => file.decisions[String(index)] === undefined).length;
  if (undecided > 0) {
    throw new ProposalError(
      "E_PROPOSAL_UNDECIDED",
      `还有 ${undecided} 条未决策，写回已阻断（每条都要先表态，避免静默跳过没看过的结论）`,
    );
  }
  const to = proposal.change.to;
  if (proposal.change.field !== "id" || typeof to !== "string" || to.trim() === "") {
    throw new ProposalError(
      "E_PROPOSAL_NO_MECHANICAL_EDIT",
      `这类改动（field=${proposal.change.field}）没有机械可写的下游编辑：只有实体改名能自动改指 refs.target。` +
        "请逐条人工处理——引擎不替你决定这条设定该怎么改。",
    );
  }
  const accepted = proposal.impact
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => file.decisions[String(index)] === "accept");
  if (accepted.length === 0) {
    throw new ProposalError("E_PROPOSAL_NOTHING", "没有任何已接受的条目，写回无事可做（全部拒绝也是一种决定，但不需要写盘）");
  }
  // 撤销窗口必须在写之前存在：快照拿不到就不写，宁可不改也不能改完回不去
  const pre = await takeSnapshot(gateway, "pre_apply_proposal", { force: true });
  if (pre.snapshot === undefined && pre.latest === undefined) {
    throw new ProposalError("E_PROPOSAL_SNAPSHOT", `写回前快照没拿到（outcome=${pre.outcome}），已阻断`);
  }
  const structure = await checkStructureFromSources(gatewayReader(gateway));
  const filePathById = new Map(structure.entities.map((entity) => [entity.id, entity.filePath]));
  const applied: number[] = [];
  for (const { row, index } of accepted) {
    const cardPath = filePathById.get(row.entity);
    if (cardPath === undefined) {
      throw new ProposalError("E_PROPOSAL_NO_FILE", `找不到受影响实体「${row.entity}」的卡文件，写回已阻断`);
    }
    const doc = await gateway.readDoc(cardPath);
    const baseline = file.sources[row.entity];
    if (baseline === undefined) {
      throw new ProposalError("E_PROPOSAL_NO_BASELINE", `提案里没有「${row.entity}」的生成时 hash，无法判断现状是否已变，写回已阻断`);
    }
    if (baseline !== doc.hash) {
      throw new ProposalError(
        "E_PROPOSAL_STALE_CONFLICT",
        `${cardPath} 在提案生成之后已被修改（baseHash 不匹配），写回已阻断——请重新生成提案再决策`,
      );
    }
    const { card, body } = readCardFile(doc.content);
    const refs = (card.refs ?? []).map((ref) => (ref.target === proposal.change.entity ? { ...ref, target: to } : ref));
    if (JSON.stringify(refs) === JSON.stringify(card.refs ?? [])) {
      // 这张卡的引用已经不是提案里那个旧 id：现状与提案不一致，不能假装成功
      throw new ProposalError("E_PROPOSAL_STALE", `${cardPath} 里已找不到指向「${proposal.change.entity}」的引用，提案与现状不一致，请重新生成`);
    }
    await gateway.writeDoc(cardPath, serializeCardFile({ ...card, refs }, body), doc.hash);
    applied.push(index);
  }
  file.applied = applied;
  proposal.status = "applied";
  file.updatedAt = new Date().toISOString();
  await gateway.writeDerived(path, serializeProposal(file), stored.hash);
  return file;
}
