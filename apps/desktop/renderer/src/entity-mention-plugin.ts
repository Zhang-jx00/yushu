import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { findMentions, type EntityIndexEntry, type MentionMatch } from "./entity-mentions";

/**
 * 源码形态的实体提及装饰（M2 / T2-2）：
 * - `@名称`（含别名）高亮为 .entity-mention，浏览器原生 title 提供悬停信息；
 * - Ctrl/⌘ + 点击命中区间 → 打开对应设定卡（跳转由 onOpen 回调处理）；
 * - 任何文档变化或实体列表变化都会重建装饰（章节级文本，成本可控；T2-4 再做增量优化）。
 */

export interface EntityMentionPluginOptions {
  getEntities: () => EntityIndexEntry[];
  onOpen: (entity: EntityIndexEntry) => void;
}

class MentionPluginValue {
  decorations: DecorationSet = Decoration.none;
  matches: MentionMatch[] = [];

  constructor(
    view: EditorView,
    private readonly options: EntityMentionPluginOptions,
  ) {
    this.build(view);
  }

  update(update: ViewUpdate): void {
    // 复核修复（2026-09-29）：仅文档/视口变化时重建（光标移动 selectionSet 无需重建，避免无谓开销）
    if (update.docChanged || update.viewportChanged) {
      this.build(update.view);
    }
  }

  /** 实体列表变化时由外部调用（Compartment reconfigure 时重建） */
  rebuild(view: EditorView): void {
    this.build(view);
  }

  private build(view: EditorView): void {
    const text = view.state.doc.toString();
    this.matches = findMentions(text, this.options.getEntities());
    const ranges = this.matches.map((match) =>
      Decoration.mark({
        class: "entity-mention",
        attributes: {
          title: `${match.entity.type}｜${match.entity.name}（Ctrl/⌘+点击查看设定卡）`,
        },
      }).range(match.start, match.end),
    );
    this.decorations = Decoration.set(ranges, true);
  }
}

export function entityMentionPlugin(options: EntityMentionPluginOptions) {
  let current: MentionPluginValue | null = null;
  const plugin = ViewPlugin.fromClass(
    class extends MentionPluginValue {
      constructor(view: EditorView) {
        super(view, options);
        current = this;
      }
      update(update: ViewUpdate): void {
        super.update(update);
        current = this;
      }
    },
    {
      decorations: (value) => value.decorations,
      eventHandlers: {
        mousedown(event, view) {
          if (!(event.ctrlKey || event.metaKey)) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null || current === null) return false;
          const hit = current.matches.find((match) => pos >= match.start && pos <= match.end);
          if (!hit) return false;
          options.onOpen(hit.entity);
          return true;
        },
      },
    },
  );
  return { plugin, getValue: () => current };
}