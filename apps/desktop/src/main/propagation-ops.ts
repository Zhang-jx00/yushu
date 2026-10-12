import { join } from "node:path";
import {
  ProposalError,
  checkStructureFromSources,
  parseProposalFile,
  propagate,
  serializeProposal,
  type Proposal,
  type ProposalDecision,
  type ProposalFile,
} from "@yushu/world-engine";
import { gatewayReader } from "./index-ops.js";
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
