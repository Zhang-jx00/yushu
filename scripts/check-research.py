#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""御书研究文档 QA 检查脚本。

用法：
    python scripts/check-research.py                # 结构质量检查（离线）
    python scripts/check-research.py --check-urls   # 追加 URL 存活检测（网络）
    python scripts/check-research.py --write-readme # 生成 docs/research/README.md 覆盖矩阵

检查项（对应交接文档 §7）：
    1. A-K 类目录是否存在            2. 领域文件是否覆盖 125 个
    3. 重复编号/重复领域             4. 模板六章节
    5. 来源 >= 6 条                  6. 来源类型 >= 3 种
    7. URL 占位符/域名级/重复        8. 含"可转化为产品规则的关键实践"
    9. 含"对御书设计的启示"          10. 标注世界构建层级
    11. 空文件/异常短文件/占位文本   12. 生成覆盖矩阵 README
"""

import argparse
import os
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

try:  # Windows 控制台中文输出
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESEARCH = os.path.join(ROOT, "docs", "research")
README_PATH = os.path.join(RESEARCH, "README.md")

# 类别 -> (目录名, 期望数量)；总计 125
CATEGORIES = [
    ("A", "A-世界起源与底层法则", 9),
    ("B", "B-地理与生态", 9),
    ("C", "C-历史与文明演化", 12),
    ("D", "D-力量与文明水平", 8),
    ("E", "E-人文与人物", 10),
    ("F", "F-叙事与故事构建", 12),
    ("G", "G-流派总论", 6),
    ("H", "H-各流派写法", 20),
    ("I", "I-网文连载工程", 9),
    ("J", "J-AI与LLM工程", 15),
    ("K", "K-软件工程与产品", 15),
]
EXPECTED_TOTAL = sum(c[2] for c in CATEGORIES)

FILE_RE = re.compile(r"^([A-K])(\d{2})-(.+)\.md$")
# 六大必备章节：按标题匹配（允许 "## 3. 领域定义" 与 "## 领域定义" 两种写法，编号可移位）
SECTION_DEFS = [
    ("领域定义", r"^##\s*(?:\d+[\.、]\s*)?领域定义"),
    ("核心知识框架", r"^##\s*(?:\d+[\.、]\s*)?核心知识框架"),
    ("可转化为产品规则的关键实践", r"^##\s*(?:\d+[\.、]\s*)?可转化为产品规则的关键实践"),
    ("信息来源", r"^##\s*(?:\d+[\.、]\s*)?信息来源"),
    ("对御书设计的启示", r"^##\s*(?:\d+[\.、]\s*)?对御书设计的启示"),
    ("子主题备忘", r"^##.*子主题备忘"),
]
# 来源行兼容两种格式："1. [类型] ..." 与 "- [类型] ..."
SOURCE_RE = re.compile(r"^\s*(?:\d+\.|-)\s*\[([^\]]+)\]\s*(.*)$")
URL_RE = re.compile(r"https?://[^\s\)\]>，。；、]+")
# 疑似未完成占位（仅告警；命中后输出上下文供人工判断）
PLACEHOLDER_TEXT = ["TODO", "【待补", "（待补", "[待补", "PLACEHOLDER", "xxxx.example"]
RULE_ID_RE = re.compile(r"`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`")
CODE_FENCE_RE = re.compile(r"^```(yaml|json|sql|toml|text)", re.M)
IDENT_RE = re.compile(r"`[A-Za-z_][A-Za-z0-9_\.\[\]]*`")
LAYER_RE = re.compile(r"世界构建金字塔层级[:：]\s*([^\n|｜]+)")
MIN_LINES = 40          # 低于该值判为异常短（错误）
SHORT_LINES = 60        # 低于该值提示（信息级）
MIN_SOURCES = 6
MIN_TYPES = 3


class Doc(object):
    def __init__(self, path, cat, num, name):
        self.path = path
        self.cat = cat
        self.num = num
        self.name = name
        self.rel = os.path.relpath(path, ROOT).replace("\\", "/")
        self.lines = []
        self.sections = {}
        self.sources = []          # (type, title, url or None)
        self.urls = []             # 来源中提取的 URL
        self.layer = ""
        self.rule_ids = []
        self.idents = []
        self.has_rules = False
        self.code_blocks = 0
        self.issues = []           # (级别, 说明)  级别: error / warn
        self.source_types = set()

    @property
    def qa_ok(self):
        return not any(lv == "error" for lv, _ in self.issues)

    def issue(self, level, msg):
        self.issues.append((level, msg))


def load_doc(path, cat, num, name):
    d = Doc(path, cat, num, name)
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    d.lines = raw.splitlines()
    text = raw
    # 空文件 / 异常短
    content_lines = [l for l in d.lines if l.strip()]
    if len(content_lines) < MIN_LINES:
        d.issue("error", "异常短文件（有效行 %d < %d）" % (len(content_lines), MIN_LINES))
    elif len(content_lines) < SHORT_LINES:
        d.issue("info", "偏短（有效行 %d）" % len(content_lines))
    # 占位文本（仅告警，输出上下文）
    for i, l in enumerate(d.lines):
        for ph in PLACEHOLDER_TEXT:
            if ph.lower() in l.lower():
                d.issue("warn", "疑似占位文本「%s」：%s" % (ph, l.strip()[:60]))
    # 六章节
    for label, pat in SECTION_DEFS:
        ok = any(re.match(pat, l) for l in d.lines)
        d.sections[label] = ok
        if not ok and label != "子主题备忘":
            d.issue("error", "缺少章节：%s" % label)
    # 世界层级
    m = LAYER_RE.search("\n".join(d.lines[:5]))
    d.layer = m.group(1).strip() if m else ""
    if not d.layer:
        d.issue("error", "未标注世界构建金字塔层级")
    # 来源
    for l in d.lines:
        m = SOURCE_RE.match(l)
        if not m:
            continue
        stype = m.group(1).strip()
        rest = m.group(2)
        urls = URL_RE.findall(rest)
        d.sources.append((stype, rest, urls[0] if urls else None))
        if urls:
            d.urls.append(urls[0])
    d.source_types = set(s[0] for s in d.sources)
    if len(d.sources) < MIN_SOURCES:
        d.issue("error", "来源不足（%d < %d）" % (len(d.sources), MIN_SOURCES))
    if len(d.source_types) < MIN_TYPES:
        d.issue("error", "来源类型不足（%d < %d）" % (len(d.source_types), MIN_TYPES))
    for stype, rest, url in d.sources:
        if not url:
            d.issue("warn", "来源缺 URL：%s" % rest[:40])
    # schema/规则（信息级；A-H 类允许散文式 schema，I-K 类要求代码块）
    d.code_blocks = len(CODE_FENCE_RE.findall(text))
    d.rule_ids = sorted(set(RULE_ID_RE.findall(text)))
    d.idents = sorted(set(IDENT_RE.findall(text)))
    d.has_rules = ("校验规则" in text) or bool(d.rule_ids)
    if d.code_blocks == 0:
        d.issue("info", "无可序列化 schema 代码块（若为散文式 schema 可忽略）")
    if not d.rule_ids:
        d.issue("info", "未检出形如 `xxx-yyy` 的规则 id")
    return d


def url_level(u):
    """深层链接 / 域名级 / 占位。"""
    if any(p in u.lower() for p in ["example.com", "xxxx", "todo"]):
        return "占位"
    rest = re.sub(r"^https?://", "", u)
    host, _, path = rest.partition("/")
    if not path or path in ("", "#"):
        return "域名级"
    return "深层"


def check_urls(docs):
    """并发 HEAD 检测 URL；返回 {url: 状态分类}。"""
    urls = []
    for d in docs:
        for u in d.urls:
            if u not in urls:
                urls.append(u)

    def probe(u):
        import urllib.request
        import urllib.error

        def http(method):
            req = urllib.request.Request(
                u, method=method,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) YushuQA/0.1"},
            )
            return urllib.request.urlopen(req, timeout=10)

        try:
            with http("HEAD") as resp:
                return u, "ok(%d)" % resp.status
        except urllib.error.HTTPError as e:
            if e.code == 404:
                # 部分站点拒绝 HEAD，改用 GET 复验
                try:
                    with http("GET") as resp:
                        return u, "ok(%d,get)" % resp.status
                except urllib.error.HTTPError as e2:
                    return u, "notfound(%d)" % e2.code
                except Exception:
                    return u, "notfound(404)"
            if e.code in (403, 405, 429, 503):
                return u, "blocked(%d)" % e.code
            return u, "httperr(%d)" % e.code
        except Exception as e:
            return u, "neterr(%s)" % type(e).__name__

    results = {}
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(probe, u): u for u in urls}
        for fut in as_completed(futs):
            u, st = fut.result()
            results[u] = st
    return results


def classify_issues(docs):
    """全局检查：重复编号 / 重复领域 / URL 重复。"""
    global_issues = []
    seen = defaultdict(list)
    for d in docs:
        seen["%s%s" % (d.cat, d.num)].append(d.rel)
    for key, paths in seen.items():
        if len(paths) > 1:
            global_issues.append(("error", "重复编号 %s：%s" % (key, paths)))
    url_count = defaultdict(list)
    for d in docs:
        for u in d.urls:
            url_count[u].append(d.rel)
    dup = {u: ps for u, ps in url_count.items() if len(ps) > 1}
    if dup:
        global_issues.append(("info", "跨文档重复 URL %d 条（同源多文档引用，通常可接受）" % len(dup)))
    return global_issues, dup


def write_readme(docs, dup_count):
    lines = []
    lines.append("# 御书 · 研究文档库（125 个知识领域）\n")
    lines.append("> 本文件由 `scripts/check-research.py --write-readme` 生成，勿手工编辑覆盖矩阵部分。\n")
    lines.append("> 领域总数：%d ｜ 文档总数：%d ｜ 覆盖矩阵列：编号｜领域｜文件｜来源数量｜来源类型数量｜世界层级｜schema/规则｜QA 状态\n" % (EXPECTED_TOTAL, len(docs)))
    lines.append("")
    lines.append("## 分类总览\n")
    lines.append("| 类别 | 目录 | 领域数 | 来源合计 | 状态 |")
    lines.append("|---|---|---:|---:|---|")
    for code, dirname, expect in CATEGORIES:
        sub = [d for d in docs if d.cat == code]
        total_src = sum(len(d.sources) for d in sub)
        bad = [d for d in sub if not d.qa_ok]
        status = "✅ 通过" if not bad else "⚠️ %d 份待修" % len(bad)
        lines.append("| %s | `%s/` | %d/%d | %d | %s |" % (code, dirname, len(sub), expect, total_src, status))
    lines.append("")
    lines.append("## 覆盖矩阵\n")
    lines.append("| 编号 | 领域 | 文件 | 来源数量 | 来源类型数量 | 世界层级 | schema/规则 | QA 状态 |")
    lines.append("|---|---|---|---:|---:|---|---|---|")
    for d in sorted(docs, key=lambda x: (x.cat, x.num)):
        coded = d.code_blocks and d.has_rules
        prose = len(d.idents) >= 3 and d.has_rules
        if coded:
            schema = "✅ 代码化"
        elif prose:
            schema = "✅ 散文式"
        elif d.code_blocks or d.has_rules:
            schema = "◐"
        else:
            schema = "—"
        if d.qa_ok:
            status = "✅ 通过"
        else:
            errs = [m for lv, m in d.issues if lv == "error"]
            status = "❌ " + "；".join(errs[:2])
        lines.append("| %s%s | %s | `%s` | %d | %d | %s | %s | %s |" % (
            d.cat, d.num, d.name, os.path.basename(d.rel), len(d.sources),
            len(d.source_types), d.layer, schema, status))
    lines.append("")
    lines.append("## 说明\n")
    lines.append("- 「来源数量/类型数量」按每份文档信息来源逐条统计，标准为 ≥6 条、≥3 种类型。")
    lines.append("- 「schema/规则」：✅ 代码化 = 含 yaml/json/sql 代码块且有校验规则；✅ 散文式 = 以字段清单/文字描述了数据结构与校验规则；◐/— = 缺位。")
    lines.append("- 跨文档重复 URL 共 %d 条（同源资料被多份文档引用，属正常）。" % dup_count)
    lines.append("- QA 复检命令：`python scripts/check-research.py`（结构）；`--check-urls` 追加 URL 存活检测。")
    lines.append("")
    with open(README_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("已生成 %s（%d 行）" % (os.path.relpath(README_PATH, ROOT), len(lines)))


def main():
    ap = argparse.ArgumentParser(description="御书研究文档 QA 检查")
    ap.add_argument("--check-urls", action="store_true", help="追加 URL 存活检测（网络请求，较慢）")
    ap.add_argument("--write-readme", action="store_true", help="生成 docs/research/README.md 覆盖矩阵")
    ap.add_argument("--quiet", action="store_true", help="仅输出问题")
    args = ap.parse_args()

    docs, missing_dirs = [], []
    for code, dirname, expect in CATEGORIES:
        cdir = os.path.join(RESEARCH, dirname)
        if not os.path.isdir(cdir):
            missing_dirs.append(dirname)
            continue
        for fn in sorted(os.listdir(cdir)):
            m = FILE_RE.match(fn)
            if not m:
                continue
            cat, num, name = m.group(1), m.group(2), m.group(3)
            docs.append(load_doc(os.path.join(cdir, fn), cat, num, name))

    errors = []
    for dirname in missing_dirs:
        errors.append("缺少目录：%s" % dirname)
    if len(docs) != EXPECTED_TOTAL:
        errors.append("文档总数 %d != 期望 %d" % (len(docs), EXPECTED_TOTAL))
    # 编号连续性
    for code, dirname, expect in CATEGORIES:
        nums = sorted(d.num for d in docs if d.cat == code)
        want = ["%02d" % i for i in range(1, expect + 1)]
        if nums and nums != want:
            errors.append("%s 类编号不连续：%s" % (code, nums))

    global_issues, dup = classify_issues(docs)

    total_src = sum(len(d.sources) for d in docs)
    fail_docs = [d for d in docs if not d.qa_ok]
    warn_docs = [d for d in docs if any(lv == "warn" for lv, _ in d.issues)]

    print("=" * 62)
    print("御书研究 QA ｜ 文档 %d/%d ｜ 来源合计 %d 条 ｜ 跨文档重复 URL %d 条"
          % (len(docs), EXPECTED_TOTAL, total_src, len(dup)))
    print("=" * 62)
    for code, dirname, expect in CATEGORIES:
        sub = [d for d in docs if d.cat == code]
        if not sub:
            continue
        srcs = [len(d.sources) for d in sub]
        types = [len(d.source_types) for d in sub]
        bad = [d for d in sub if not d.qa_ok]
        print("%s 类 %2d 份 ｜ 来源 %d~%d 条 ｜ 类型 %d~%d 种 ｜ %s"
              % (code, len(sub), min(srcs), max(srcs), min(types), max(types),
                 "✅" if not bad else "❌ " + ", ".join(os.path.basename(d.rel) for d in bad[:3])))

    print("-" * 62)
    for lv, msg in errors + global_issues:
        if lv == "error":
            print("[错误] %s" % msg)
        elif not args.quiet:
            print("[提示] %s" % msg)

    if fail_docs:
        print("-" * 62)
        for d in fail_docs:
            print("[不合格] %s" % d.rel)
            for lv, msg in d.issues:
                if lv == "error":
                    print("    - %s" % msg)
    if warn_docs and not args.quiet:
        print("-" * 62)
        print("以下 %d 份存在警告（不阻断）：" % len(warn_docs))
        for d in warn_docs:
            ws = [m for lv, m in d.issues if lv == "warn"]
            print("    · %s：%s" % (os.path.basename(d.rel), "；".join(ws[:3])))

    if args.check_urls:
        print("-" * 62)
        print("开始 URL 存活检测（%d 条，可能需要几分钟）..." % sum(len(d.urls) for d in docs))
        t0 = time.time()
        results = check_urls(docs)
        buckets = defaultdict(list)
        for u, st in results.items():
            buckets[st.split("(")[0]].append(u)
        print("检测完成（%.1f 秒）：" % (time.time() - t0))
        for k in sorted(buckets):
            print("  %-10s %d 条" % (k, len(buckets[k])))
        bad = buckets.get("notfound", []) + buckets.get("neterr", [])
        if bad:
            print("以下 URL 需人工复核：")
            for u in bad[:40]:
                print("    - %s" % u)
        levels = defaultdict(int)
        for d in docs:
            for u in d.urls:
                levels[url_level(u)] += 1
        print("URL 分级：深层链接 %d ｜ 域名级 %d ｜ 占位 %d"
              % (levels.get("深层", 0), levels.get("域名级", 0), levels.get("占位", 0)))

    if args.write_readme:
        write_readme(docs, len(dup))

    print("=" * 62)
    if errors or fail_docs:
        print("结论：存在不合格项，需修复。")
        return 1
    print("结论：全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())