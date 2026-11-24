/* SPDX-License-Identifier: Apache-2.0 */
/**
 * R191：首章预热——章纲里第一个「已回填 chapter_id」的章，就是编辑器挂载时该先打开的那一章。
 *
 * 为什么单独成形：编辑器挂载时若等 `ai.drafts` 的整本清单，会把 335 章逐章读盘（只为了
 * hasBody / wordCount）约 600ms 花在「第一章是哪章」这件事上；而章纲里 chapter_id 已回填
 * ⇒ 读一份章纲就能定首章路径。清单随后到达，界面按既有规则校正（prev 在清单里就保留）。
 *
 * 口径：`listDraftTargets` 也是按同一份章纲的卷/章顺序取第一章 ⇒ 两边选出的首章一致。
 * 路径规则走引擎的 `chapterPath`（与主进程同一个出处，不另立一套路径拼法）。
 */
import { chapterPath } from "@yushu/world-engine";
import type { OutlineDocPayload } from "../../src/shared/ipc.js";

export function firstDraftPath(doc: OutlineDocPayload): string | null {
  for (const volume of doc.volumes) {
    for (const chapter of volume.chapters) {
      if (!chapter.chapter_id) continue;
      return chapterPath(volume.id, chapter.chapter_id);
    }
  }
  return null;
}
