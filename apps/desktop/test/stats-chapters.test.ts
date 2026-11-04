/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChapterDist } from "../src/main/stats-chapters.js";
import type { LibraryChapterEntry } from "../src/shared/ipc.js";

/**
 * 逐章字数分布（R167，T5-6 剩余片）的纯函数判据。
 *
 * 页面上摆的每一个数（章数 / 有稿数 / 平均 / 最短点名）都由 `buildChapterDist` 算出来
 * ⇒ 它算错，页面上就是错的，而"看起来合理的分布"没人会去核。判据盯四件事：
 * ① **按书序**（清单顺序原样）——按字数一排序，长尾的形状就撒谎了；
 * ② **平均只数有稿的章**（分母不含未建草稿）——混进来会把平均摊薄成假象；
 * ③ **空项目不画假图**——没有章时 chapters 为空数组、avgWords 为 null（不是 0）；
 * ④ **未建草稿不冒充 0**——words 为 null，界面摆「未建草稿」，bar 不画。
 */

const ROOT = join(__dirname, "..", "..", "..");
const view = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "StatsView.tsx"), "utf8");

const chapter = (over: Partial<LibraryChapterEntry> & { idx: number; title: string }): LibraryChapterEntry => ({
  volumeId: "v1",
  volumeTitle: "第一卷",
  chapterId: `co-${over.idx}`,
  chapterPath: `chapters/c${over.idx}.md`,
  wordCount: 1000,
  status: "draft",
  hash: "h",
  ...over,
});

describe("逐章字数分布（R167）：buildChapterDist", () => {
  it("**按书序**（清单顺序原样；不按字数排序——排序一变长尾的形状就撒谎）", () => {
    const dist = buildChapterDist([
      chapter({ idx: 1, title: "甲", wordCount: 3000 }),
      chapter({ idx: 2, title: "乙", wordCount: 500 }),
      chapter({ idx: 3, title: "丙", wordCount: 2000 }),
    ]);
    expect(dist.chapters.map((row) => row.title)).toEqual(["甲", "乙", "丙"]);
  });

  it("**有稿 / 无稿计数**与全部章数对得上", () => {
    const dist = buildChapterDist([
      chapter({ idx: 1, title: "甲" }),
      chapter({ idx: 2, title: "乙", chapterPath: null, wordCount: 0, status: "" }),
      chapter({ idx: 3, title: "丙" }),
    ]);
    expect(dist.totalChapters).toBe(3);
    expect(dist.withDraft).toBe(2);
    expect(dist.noDraft).toBe(1);
  });

  it("**未建草稿不冒充 0**：words 为 null（不是 0）", () => {
    const dist = buildChapterDist([chapter({ idx: 1, title: "甲", chapterPath: null, wordCount: 0, status: "" })]);
    expect(dist.chapters[0]?.words).toBeNull();
  });

  it("**平均只数有稿的章**（分母不含未建草稿；四舍五入）", () => {
    const dist = buildChapterDist([
      chapter({ idx: 1, title: "甲", wordCount: 1000 }),
      chapter({ idx: 2, title: "乙", wordCount: 1001 }),
      chapter({ idx: 3, title: "丙", chapterPath: null, wordCount: 0, status: "" }),
    ]);
    // (1000 + 1001) / 2 = 1000.5 ⇒ 1001；未建草稿的 0 不进分母
    expect(dist.avgWords).toBe(1001);
  });

  it("**拖后腿点名**：shortest 是有稿章里字数最少的（并列取先出现的；未建草稿不参与）", () => {
    const dist = buildChapterDist([
      chapter({ idx: 1, title: "甲", wordCount: 2000 }),
      chapter({ idx: 2, title: "乙", wordCount: 300 }),
      chapter({ idx: 3, title: "丙", wordCount: 300 }),
      chapter({ idx: 4, title: "丁", chapterPath: null, wordCount: 0, status: "" }),
    ]);
    expect(dist.shortest?.title).toBe("乙");
    expect(dist.shortest?.words).toBe(300);
  });

  it("**空项目不画假图**：没有章时 chapters 为空数组、avgWords 为 null（不是 0）", () => {
    const dist = buildChapterDist([]);
    expect(dist.totalChapters).toBe(0);
    expect(dist.withDraft).toBe(0);
    expect(dist.chapters).toEqual([]);
    expect(dist.avgWords).toBeNull();
    expect(dist.shortest).toBeNull();
  });

  it("**全部未建草稿**：withDraft=0、avgWords=null、shortest=null（不拿 0 冒充平均）", () => {
    const dist = buildChapterDist([
      chapter({ idx: 1, title: "甲", chapterPath: null, wordCount: 0, status: "" }),
      chapter({ idx: 2, title: "乙", chapterPath: null, wordCount: 0, status: "" }),
    ]);
    expect(dist.withDraft).toBe(0);
    expect(dist.noDraft).toBe(2);
    expect(dist.avgWords).toBeNull();
    expect(dist.shortest).toBeNull();
    expect(dist.chapters.every((row) => row.words === null)).toBe(true);
  });

  it("**界面渲染走后端给的同一份结构**（认用法：不自己造数、空态认 payload 的 totalChapters）", () => {
    // 认**用法**（读 state.chapterDist 渲染），不认"出现过"——R166 的变异教训：
    // 注释里提常量名也能喂绿，所以要认的是渲染分支上的比较与映射本身。
    expect(view, "StatsView 没有渲染后端的 chapterDist ⇒ 界面自己造数会与真源漂").toContain(
      "state?.chapterDist",
    );
    expect(view, "空态分支没有认 payload（totalChapters）⇒ 空项目会画假图").toContain(
      "dist.totalChapters > 0",
    );
    // 行上有对账用的**精确形态**数据属性（预演 step151 按它们逐行对账）
    expect(view, "行上没有 data-chapter-draft ⇒ 预演无法逐行对账").toContain('data-chapter-draft=');
    expect(view, "行上没有 data-chapter-words ⇒ 预演无法核对字数").toContain('data-chapter-words=');
  });
});
