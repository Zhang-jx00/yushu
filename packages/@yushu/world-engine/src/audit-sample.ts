/**
 * 全书体检的 AI 采样器（M4 / T4-4 的"重规则 + AI 采样"，R58）。
 *
 * 采样必须**确定性**：同一批正文两次结果逐字相同，作者才可能比较两次体检，
 * 也才说得清"这条 AI 结论是从哪一段来的"。所以这里不引入随机数与 seed——
 * 规则本身就是确定的：段落按空行切分，够长的才参与，按章轮转每轮取下一段。
 */

export interface AuditSampleInput {
  chapterId: string;
  path: string;
  body: string;
}

export interface AuditSample {
  chapterId: string;
  path: string;
  /** 章内正文字符下标，**UTF-16 口径**（与中文自查、一致性报告同一轴，面板可直接高亮） */
  start: number;
  end: number;
  quote: string;
}

/** 短于此的段落不参与采样：一句"今天写完了"没有核验价值，只会白烧 token */
const MIN_PARAGRAPH_CHARS = 12;

interface Paragraph {
  start: number;
  end: number;
  quote: string;
}

function paragraphsOf(body: string): Paragraph[] {
  const out: Paragraph[] = [];
  let offset = 0;
  for (const raw of body.split(/\n[ \t]*\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length >= MIN_PARAGRAPH_CHARS) {
      const lead = raw.length - raw.trimStart().length;
      const start = offset + lead;
      out.push({ start, end: start + trimmed.length, quote: trimmed });
    }
    offset += raw.length + 2; // 加回被 split 吃掉的空行分隔（\n\n）
  }
  return out;
}

export function sampleForAudit(chapters: readonly AuditSampleInput[], limit: number): AuditSample[] {
  if (limit <= 0) return [];
  const pool = chapters
    .map((chapter) => ({ chapterId: chapter.chapterId, path: chapter.path, paragraphs: paragraphsOf(chapter.body) }))
    .filter((entry) => entry.paragraphs.length > 0);
  const samples: AuditSample[] = [];
  for (let round = 0; samples.length < limit; round += 1) {
    let tookAny = false;
    for (const entry of pool) {
      const paragraph = entry.paragraphs[round];
      if (!paragraph) continue;
      tookAny = true;
      samples.push({
        chapterId: entry.chapterId,
        path: entry.path,
        start: paragraph.start,
        end: paragraph.end,
        quote: paragraph.quote,
      });
      if (samples.length >= limit) break;
    }
    if (!tookAny) break; // 段落取完就如实少给，不重复凑数
  }
  return samples;
}
