import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { findMentions, type EntityIndexEntry, type MentionMatch } from "./entity-mentions";
import { cardTypeLabel } from "./card-labels";

/**
 * 源码形态的实体提及装饰（M2 / T2-2）：
 * - `@名称`（含别名）高亮为 .entity-mention，浏览器原生 title 提供悬停信息；
 * - Ctrl/⌘ + 点击命中区间 → 打开对应设定卡（跳转由 onOpen 回调处理）；
 * - 任何文档变化或实体列表变化都会重建装饰（章节级文本，成本可控；T2-4 再做增量优化）；
 * - 大文档（T2-4 切片 B）：超过 largeDocThreshold 时逐键重建改为 debounceMs 节流合并——
 *   既有装饰由 ProseMirror 随事务自动映射（位置仍有效），延迟重算后用空事务触发重绘。
 */

export interface EntityMentionPluginOptions {
  getEntities: () => EntityIndexEntry[];
  onOpen: (entity: EntityIndexEntry) => void;
  /** 大文档阈值（字符）；与 debounceMs 同时 > 0 才启用节流 */
  largeDocThreshold?: number;
  /** 节流间隔（ms） */
  debounceMs?: number;
}

class MentionPluginValue {
  decorations: DecorationSet = Decoration.none;
  matches: MentionMatch[] = [];
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    view: EditorView,
    private readonly options: EntityMentionPluginOptions,
  ) {
    this.build(view);
  }

  update(update: ViewUpdate): void {
    // 复核修复（2026-09-29）：仅文档/视口变化时重建（光标移动 selectionSet 无需重建，避免无谓开销）
    if (!update.docChanged && !update.viewportChanged) return;
    const threshold = this.options.largeDocThreshold ?? 0;
    const delay = this.options.debounceMs ?? 0;
    if ((update.docChanged || update.viewportChanged) && threshold > 0 && delay > 0 && update.state.doc.length > threshold) {
      // 大文档节流：合并高频重建（最后一次输入后 delay 毫秒重算一次）
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = null;
        this.build(update.view);
        // 空事务触发视图重读 decorations（build 后需一次 update 才重绘）
        update.view.dispatch(update.view.state.update({}));
      }, delay);
      return;
    }
    this.build(update.view);
  }

  destroy(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
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
          title: `${cardTypeLabel(match.entity.type)}｜${match.entity.name}（Ctrl/⌘+点击查看设定卡）`,
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