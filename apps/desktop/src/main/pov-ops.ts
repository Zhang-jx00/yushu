/* SPDX-License-Identifier: Apache-2.0 */
import { YushuError } from "@yushu/core";
import type { CardSummary } from "../shared/ipc.js";
import {
  CHAPTERS_DIR,
  OUTLINE_PATH,
  POV_CHECK_ORIGIN,
  POV_CONFIG_PATH,
  chapterPath,
  checkPovConsistency,
  parseOutline,
  parsePovConfig,
  readChapterFile,
  serializeChapterFile,
  type PovConfig,
  type ReportFinding,
} from "@yushu/world-engine";
import type {
  PovChapterRowPayload,
  PovFindingPayload,
  PovPreviewPayload,
  PovPreviewRequest,
  PovSetChapterPayload,
  PovSetChapterResult,
  PovWriteConfigPayload,
  PovWriteResult,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { listCards } from "./project-ops.js";

/**
 * 视角看板的主进程侧（M4 / T4-2 第三批，R102）。
 *
 * 判定全在引擎（`pov-config.ts` + `pov-check.ts`，出处 F04 §3.1/§3.2/§3.6），本模块只做三件事：
 * ① 读 `config/pov.yaml` 并**如实区分三种状态**（declared / undeclared / unreadable）——
 *    读不了的时候一条结论都不发，因为"解析失败的策略"被当成"没问题的策略"是最坏的一种假绿灯；
 * ② 从大纲 + 章节文件拼出逐章视角（真源，不读索引：删掉 `.yushu/index.db` 后结论必须不变，A5 口径）；
 * ③ 两个写入点：策略文件与本章视角。**都带 baseHash**，且只改该改的那一处
 *    （绑视角不动正文与字数，否则编辑器与看板会互相覆盖）。
 *
 * `pov` 这个字段在数据模型里早就有了（`createChapterDraft` 就写 `pov: ""`），缺的从来不是字段，
 * 是**界面上无处可填**——本轮补的就是那个写入点。
 */

const CHAPTER_PREFIX = `${CHAPTERS_DIR}/`;

function characterIds(cards: readonly CardSummary[]): string[] {
  return cards
    .filter((card) => card.error === undefined && card.type === "character" && card.id !== "")
    .map((card) => card.id)
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/** 解析结果摊平成面板字段（未设的给空值，面板据此显示"策略里没写这一项"） */
function flatten(config: PovConfig | null): Pick<
  PovPreviewPayload,
  "mode" | "distance" | "defaultPov" | "allowedPovs" | "granularity" | "minGapChapters" | "signalRequired" | "exemptions"
> {
  return {
    mode: config?.mode ?? "",
    distance: config?.distance ?? "",
    defaultPov: config?.default_pov ?? "",
    allowedPovs: config?.allowed_povs ?? [],
    granularity: config?.switch_policy?.granularity ?? "",
    minGapChapters: config?.switch_policy?.min_gap_chapters ?? null,
    signalRequired: config?.switch_policy?.signal_required ?? null,
    exemptions: config?.exemptions ?? [],
  };
}

export async function previewPov(
  gateway: ProjectGateway,
  request: PovPreviewRequest = {},
): Promise<PovPreviewPayload> {
  const snap = await gateway.readDoc(POV_CONFIG_PATH).catch(() => null);
  let state: PovPreviewPayload["state"] = "undeclared";
  let config: PovConfig | null = null;
  let configError: string | null = null;
  if (snap) {
    try {
      config = parsePovConfig(snap.content);
      state = config === null ? "undeclared" : "declared";
    } catch (err) {
      state = "unreadable";
      configError = err instanceof Error ? err.message : String(err);
    }
  }

  // 逐章视角：大纲给顺序与标题，章节文件给 frontmatter（未建草稿的章不参与核对）
  const outlineSnap = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  const chapters: PovChapterRowPayload[] = [];
  let seq = 0;
  if (outlineSnap) {
    const outline = parseOutline(outlineSnap.content);
    for (const volume of outline.volumes) {
      for (const item of volume.chapters) {
        seq += 1;
        const draftPath = item.chapter_id ? chapterPath(volume.id, item.chapter_id) : null;
        const file = draftPath ? await gateway.readDoc(draftPath).catch(() => null) : null;
        if (file === null) {
          chapters.push({
            chapterId: item.id,
            path: null,
            volumeTitle: volume.title,
            title: item.title,
            idx: seq,
            pov: "",
            drafted: false,
            hash: null,
          });
          continue;
        }
        let pov = "";
        let chapterId = item.chapter_id ?? "";
        try {
          const parsed = readChapterFile(file.content);
          pov = parsed.chapter.pov;
          chapterId = parsed.chapter.id;
        } catch {
          // 章节文件读不动：这一章按"未声明视角"呈现，路径仍在（编辑器打开时会给完整错误）
        }
        chapters.push({
          chapterId,
          path: file.path,
          volumeTitle: volume.title,
          title: item.title,
          idx: seq,
          pov,
          drafted: true,
          hash: file.hash,
        });
      }
    }
  }

  const cards = await listCards(gateway);
  const known = characterIds(cards);
  const names = new Map(cards.map((card) => [card.id, card.name]));

  const drafted = chapters.filter((row) => row.drafted);
  // declared 与 undeclared 都跑：引擎对"没声明"给的是**一条 info 总述**（而不是逐章警告），
  // 那句话本身就是面板要显示的内容——"没核对过"必须比"没结论"更响。
  // unreadable 不跑：解析失败的策略不能拿来判定，也不能伪装成"没声明"。
  const findings: PovFindingPayload[] =
    state === "unreadable"
      ? []
      : checkPovConsistency({
          chapters: drafted.map((row) => ({
            chapterId: row.chapterId,
            path: row.path ?? "",
            title: row.title,
            idx: row.idx,
            pov: row.pov,
          })),
          characterIds: known,
          config,
          strict: request.strict ?? true,
        }).map((row) => ({ ...row }));

  return {
    configPath: POV_CONFIG_PATH,
    state,
    configText: snap?.content ?? "",
    configHash: snap?.hash ?? null,
    configError,
    ...flatten(config),
    characters: known.map((id) => ({ id, name: names.get(id) ?? id })),
    chapters,
    findings,
    counted: {
      outlineChapters: chapters.length,
      drafted: drafted.length,
      notDrafted: chapters.length - drafted.length,
      withPov: drafted.filter((row) => row.pov.trim() !== "").length,
      characters: known.length,
      findings: findings.length,
    },
  };
}

/**
 * 保存策略文件：**先解析后落盘**。
 *
 * 解析不过就抛 `E_POV_CONFIG` 并且一个字节不写——写了坏文件等于把"这次没核对"变成
 * "以后每次都核对不了"。哈希比对放在写入前，为的是给作者一句能看懂的话
 * （gateway 的冲突错误只讲路径，不讲"你看到的还是不是这一版"）。
 */
export async function writePovConfig(
  gateway: ProjectGateway,
  payload: PovWriteConfigPayload,
): Promise<PovWriteResult> {
  const content = typeof payload.content === "string" ? payload.content : "";
  try {
    parsePovConfig(content);
  } catch (err) {
    throw new YushuError("E_POV_CONFIG", err instanceof Error ? err.message : String(err));
  }
  const current = await gateway.readDoc(POV_CONFIG_PATH).catch(() => null);
  const expected = current?.hash ?? null;
  if (expected !== payload.baseHash) {
    throw new YushuError(
      "E_DOC_CONFLICT",
      current === null
        ? `写入冲突（${POV_CONFIG_PATH}）：文件已不存在，请重新预览后再保存`
        : `写入冲突（${POV_CONFIG_PATH}）：策略文件在你编辑期间被改过（外部编辑或另一次保存），请重新载入后再写`,
    );
  }
  // 走到这里哈希必然对得上（上面已比对）：文件不存在时按"新建"写（不传 baseHash），
  // 存在时带着作者看到的那份 baseHash 写——两种情况都不许盲写。
  const written = await gateway.writeDoc(
    POV_CONFIG_PATH,
    content,
    current === null ? undefined : (payload.baseHash ?? undefined),
  );
  return { path: POV_CONFIG_PATH, hash: written.hash };
}

/**
 * 并进「全书体检」那一张表的那一份投影（同 R75 伏笔、R97 战力的做法：判定在引擎，这里只转形状）。
 *
 * 为什么要并进而不是只在视角看板显示：体检表是**豁免与豁免率的口径来源**
 * （`config/consistency.yaml` 只认这张表里出现过的规则 id）。逐章视角结论若不并进，
 * 作者想放过一条就得去改两个文件，而"改不动的结论"最后学会的是忽略红色。
 * 注意这与 `config/pov.yaml` 的 exemptions 是两套东西：那份是"这一章按全知写"的**叙事豁免**，
 * 这条是"这条结论本轮我不想处理"的**体检豁免**——面板要把两句话说清，不能混成一个词。
 *
 * **两种"没核对"分开处理**（R102 复核时按既有口径定的）：
 * - 作者**没写** `config/pov.yaml` ⇒ 这里返回空。那条"策略未声明"的 info 属于**视角看板**，
 *   与它同一页；体检表的既有口径是"info 行代表有数据且数据里有缺口"，不是"某功能未配置"
 *   （战力台账 `powerup-gate-no-data` 也是那个口径：没有台账就一条不发）。
 *   给每个没配视角的项目在体检表里常驻一行 info，教会作者的同样是忽略红色。
 * - 作者**写了但读不了** ⇒ 进表一条 `pov-config-unreadable`（warn）。这是他自己文件里的缺陷，
 *   与 `fs-ledger-unreadable` 同一条路子：静默零结论会被读成"没问题"，那种假绿灯不许存在。
 */
export const POV_UNREADABLE_RULE = "pov-config-unreadable";

export async function povReportFindings(
  gateway: ProjectGateway,
  request: PovPreviewRequest = {},
): Promise<ReportFinding[]> {
  const snap = await gateway.readDoc(POV_CONFIG_PATH).catch(() => null);
  if (snap === null || snap.content.trim() === "") return [];
  let config: PovConfig | null;
  try {
    config = parsePovConfig(snap.content);
  } catch (err) {
    return [
      {
        rule: POV_UNREADABLE_RULE,
        severity: "warn",
        subject: POV_CONFIG_PATH,
        evidence: `${POV_CONFIG_PATH} 读不了，本轮没有视角结论：${err instanceof Error ? err.message : String(err)}`,
        fix: "按报错改掉那一行（未知键、非法 mode、非整数的 min_gap_chapters 都会整份拒绝）；不想再被核对就干脆删掉这个文件，那会回到「未声明」。",
        origin: POV_CHECK_ORIGIN,
      },
    ];
  }
  // 空文件 = 没声明（与 undeclared 同口径：不进体检表，由看板那句话对外说明）
  if (config === null) return [];
  const view = await previewPov(gateway, request);
  return view.findings.map(toReportFinding);
}

function toReportFinding(row: PovFindingPayload): ReportFinding {
  return {
    rule: row.rule,
    severity: row.severity,
    subject: row.subject,
    ...(row.related === undefined ? {} : { related: row.related }),
    evidence: row.evidence,
    fix: row.fix,
    origin: row.origin,
  };
}

/**
 * 给某一章绑视角：只重写 frontmatter 的 `pov`，正文与 `word_count` 原样带回
 * （正文的写入口只有编辑器那条 `chapter:write`，两处都写就会互相覆盖）。
 */
export async function setChapterPov(
  gateway: ProjectGateway,
  payload: PovSetChapterPayload,
): Promise<PovSetChapterResult> {
  if (!payload.path.startsWith(CHAPTER_PREFIX)) {
    throw new YushuError(
      "E_POV_TARGET",
      `视角只能写在章节文件上（chapters/ 下的草稿），「${payload.path.split("/").pop() ?? payload.path}」不是章节`,
    );
  }
  const pov = payload.pov.trim();
  if (pov !== "") {
    const known = characterIds(await listCards(gateway));
    if (!known.includes(pov)) {
      throw new YushuError(
        "E_POV_CHARACTER",
        `项目里没有角色「${pov}」：视角必须绑到已建档的角色（当前角色卡 ${String(known.length)} 张）。先建那张卡，或换一个。`,
      );
    }
  }
  const snapshot = await gateway.readDoc(payload.path);
  const { chapter, body } = readChapterFile(snapshot.content);
  const written = await gateway.writeDoc(payload.path, serializeChapterFile({ ...chapter, pov }, body), payload.baseHash);
  return { path: payload.path, hash: written.hash, pov };
}
