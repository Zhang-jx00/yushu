/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createProject, writeCardDoc } from "../src/main/project-ops.js";
import {
  applyProposal,
  decideProposal,
  listProposals,
  proposalDirOf,
  previewPropagation,
} from "../src/main/propagation-ops.js";
import { snapshotState } from "../src/main/snapshot-ops.js";

/**
 * 影响传播的桌面侧（M4 / T4-5，R61）。
 *
 * 这一轮只到"提案可见 + 决策可记"，**不写回真源**（写回在下一轮，因此 T4-5 不勾选）。
 * 所以最要紧的三条断言都是围绕"不许碰真源"：
 * ① 预览与决策跑完，设定卡与章节的**字节一个都不能变**（A1 的"未确认项不得落库"就是这个意思）；
 * ② 提案落 `.yushu/proposals/`（派生物：不入 Git、不入索引、不进快照），且**同一改动不堆重复文件**；
 * ③ 坏提案文件**报错点名**，不静默跳过——静默跳过等于"你的提案没了"。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

let dir: string;
let gateway: ProjectGateway;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-prop-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: { id: "law-spirit", type: "law", name: "灵气浓度", layer: "laws" },
    body: "天地灵气决定修行上限。",
  });
  await writeCardDoc(gateway, {
    card: {
      id: "geo-valley",
      type: "location",
      name: "云隐谷",
      layer: "geography",
      refs: [{ relation: "依存", target: "law-spirit" }],
    },
    body: "灵气汇聚之地。",
  });
  await writeCardDoc(gateway, {
    card: {
      id: "char-linyuan",
      type: "character",
      name: "林渊",
      layer: "characters",
      refs: [{ relation: "遵循", target: "geo-valley" }],
    },
    body: "生于云隐谷。",
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const truthBytes = () =>
  readdirSync(join(dir, "world"), { recursive: true })
    .filter((name) => String(name).endsWith(".md"))
    .map((name) => [String(name), readFileSync(join(dir, "world", String(name)), "utf8")])
    .sort();

describe("影响传播提案（桌面侧）", () => {
  it("预览产出带路径的清单并落派生目录，真源字节不变", async () => {
    const before = truthBytes();
    const out = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    expect(out.proposal.impact.map((row) => row.entity)).toEqual(["geo-valley", "char-linyuan"]);
    expect(out.proposal.impact[1]?.path).toEqual(["law-spirit", "geo-valley", "char-linyuan"]);
    expect(out.path.startsWith(".yushu/proposals/")).toBe(true);
    expect(truthBytes()).toEqual(before);
  });

  it("同一改动再预览一次不堆重复文件（提案 id 由内容决定）", async () => {
    const first = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    const second = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    expect(second.proposal.proposalId).toBe(first.proposal.proposalId);
    expect(second.path).toBe(first.path);
    expect(readdirSync(proposalDirOf(gateway)).length).toBe(1);
  });

  it("决策写进提案文件，未决策条数如实给", async () => {
    const { proposal } = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    const id = proposal.proposalId;
    await decideProposal(gateway, id, 0, "accept");
    const [stored] = await listProposals(gateway);
    expect(stored?.decisions).toEqual({ 0: "accept" });
    expect(stored?.undecidedCount).toBe(1);
    // 决策本身也不许碰真源
    expect(stored?.proposal.impact.length).toBe(2);
  });

  it("决策下标越界要报错点名，不能静默忽略", async () => {
    const { proposal } = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    await expect(decideProposal(gateway, proposal.proposalId, 7, "reject")).rejects.toThrow(/越界/);
  });

  it("成环的提案是 blocked：没有可决策项，决策被拒且环路径在文件里", async () => {
    await writeCardDoc(gateway, {
      card: {
        id: "law-spirit",
        type: "law",
        name: "灵气浓度",
        layer: "laws",
        refs: [{ relation: "回溯", target: "geo-valley" }],
      },
      body: "天地灵气决定修行上限。",
      baseHash: (await gateway.readDoc("world/cards/law/law-spirit.md")).hash,
    });
    const out = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    expect(out.proposal.status).toBe("blocked");
    expect(out.proposal.cycle?.length).toBeGreaterThan(1);
    await expect(decideProposal(gateway, out.proposal.proposalId, 0, "accept")).rejects.toThrow(/阻断/);
  });

  it("坏提案文件报错点名，不静默跳过", async () => {
    const { path } = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    writeFileSync(join(dir, path), "apiVersion: yushu.proposal/v1\nunknown_key: 1\n", "utf8");
    await expect(listProposals(gateway)).rejects.toThrow(/unknown_key|未知键/);
  });

  it("实体不存在时抛错，且不留下半份提案文件", async () => {
    await expect(previewPropagation(gateway, { entity: "ghost", field: "content" })).rejects.toThrow(/不在设定索引/);
    expect(existsSync(proposalDirOf(gateway)) ? readdirSync(proposalDirOf(gateway)).length : 0).toBe(0);
  });
});

/**
 * 写回真源（R62）：`applyProposal` 只做**机械可确定**的那一种编辑——
 * 被改的是实体 id（`change.field === "id"` 且带 `to`），下游那些 `refs.target` 指旧 id 的卡
 * 按已 accept 的条目逐条改指新 id。除此之外（比如改了法则正文）**没有**机械可写的下游动作，
 * 此时必须拒绝并说清楚，而不是"顺手往卡里写个待复核标记"——那是把引擎的判断伪装成作者的决定。
 */
describe("applyProposal 写回真源（R62）", () => {
  const refsOf = async (path: string) => (await gateway.readDoc(path)).content;

  it("改名提案：只有已接受的条目被改指新 id，被拒的一条都不动", async () => {
    const { proposal } = await previewPropagation(gateway, { entity: "law-spirit", field: "id", to: "law-spirit-v2" });
    const id = proposal.proposalId;
    // 两条：geo-valley（直接引用）与 char-linyuan（间接）——只接受第一条，第二条拒绝
    await decideProposal(gateway, id, 0, "accept");
    await decideProposal(gateway, id, 1, "reject");
    const out = await applyProposal(gateway, id);
    expect(out.applied).toEqual([0]);
    expect(out.proposal.status).toBe("applied");
    const geo = await refsOf("world/cards/location/geo-valley.md");
    expect(geo).toContain("law-spirit-v2");
    expect(geo).not.toMatch(/target: law-spirit$/m);
    const char = await refsOf("world/cards/character/char-linyuan.md");
    expect(char).toContain("geo-valley");
    // 改名本身不自动落到被改卡上（那是作者已经在真源里做的事），这里只动引用方
    expect(await refsOf("world/cards/law/law-spirit.md")).toContain("id: law-spirit");
  });

  it("还有条目没表态时拒绝写回（「全部决策完成」这道闸不能省）", async () => {
    const { proposal } = await previewPropagation(gateway, { entity: "law-spirit", field: "id", to: "law-spirit-v3" });
    await decideProposal(gateway, proposal.proposalId, 0, "accept");
    await expect(applyProposal(gateway, proposal.proposalId)).rejects.toThrow(/未决策|未表态/);
    expect(await refsOf("world/cards/location/geo-valley.md")).not.toContain("law-spirit-v3");
  });

  it("正文类改动没有机械可写的下游编辑：拒绝并说明，真源不变", async () => {
    const { proposal } = await previewPropagation(gateway, { entity: "law-spirit", field: "content" });
    const geoBefore = await gateway.readDoc("world/cards/location/geo-valley.md");
    const charBefore = await gateway.readDoc("world/cards/character/char-linyuan.md");
    await decideProposal(gateway, proposal.proposalId, 0, "accept");
    await decideProposal(gateway, proposal.proposalId, 1, "accept");
    await expect(applyProposal(gateway, proposal.proposalId)).rejects.toThrow(/没有机械可写/);
    expect((await gateway.readDoc("world/cards/location/geo-valley.md")).hash).toBe(geoBefore.hash);
    expect((await gateway.readDoc("world/cards/character/char-linyuan.md")).hash).toBe(charBefore.hash);
  });

  it("写回前强制 pre_apply_proposal 快照（撤销窗口在写之前，不在之后）", async () => {
    const { proposal } = await previewPropagation(gateway, { entity: "law-spirit", field: "id", to: "law-spirit-v4" });
    await decideProposal(gateway, proposal.proposalId, 0, "accept");
    await decideProposal(gateway, proposal.proposalId, 1, "pending");
    expect((await snapshotState(gateway)).snapshots.some((s) => s.reason === "pre_apply_proposal")).toBe(false);
    await applyProposal(gateway, proposal.proposalId);
    expect((await snapshotState(gateway)).snapshots.some((s) => s.reason === "pre_apply_proposal")).toBe(true);
  });

  it("目标卡被外部改过时按 baseHash 拒写，不盲写", async () => {
    const { proposal } = await previewPropagation(gateway, { entity: "law-spirit", field: "id", to: "law-spirit-v5" });
    await decideProposal(gateway, proposal.proposalId, 0, "accept");
    await decideProposal(gateway, proposal.proposalId, 1, "reject");
    const geo = await gateway.readDoc("world/cards/location/geo-valley.md");
    await gateway.writeDoc("world/cards/location/geo-valley.md", `${geo.content}外部又加了一句。\n`, geo.hash);
    await expect(applyProposal(gateway, proposal.proposalId)).rejects.toThrow(/baseHash|已被外部修改/);
    expect(await gateway.readDoc("world/cards/location/geo-valley.md").then((r) => r.content)).toContain("外部又加了一句");
  });
});
