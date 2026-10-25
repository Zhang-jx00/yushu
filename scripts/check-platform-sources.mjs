#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";

/**
 * 平台规则包的**来源可访问性**核对脚本（T5-8 / R177）。
 *
 * 为什么要有这个脚本：台账里写「已核对」是一句**声明**，
 * 而这一行的价值全在**能不能当场重跑一遍**。所以出处里的每个 URL 都要真的抓一次，
 * 把状态码与核对日期落到 stdout，退出码非 0 即为有问题。
 *
 * 口径（与 `packages/@yushu/export/src/platform-spec.ts` 同一套）：
 * ① 抓的是**包登记过的页面**（`source_urls`）与**每条规则的出处链接**；
 * ② 状态码 2xx / 3xx 算通得过；404 / 5xx / 连不上都算**核不到**——那一条规则就失效了；
 * ③ 只读、只报，不改盘；`--offline` 只列清单不抓（离线也能核对清单）。
 *
 * 为什么不用 fetch 一把梭：有的站点（如七猫）返回的响应头**本身不合规**
 * （header 值后面多一个空白），严格解析器（undici / llhttp）会直接判 Parse Error，
 * 而页面其实是在的。于是这里加一条兜底：**fetch 失败就用原始 TLS 连接读状态行**，
 * 只取第一行 `HTTP/1.1 200 OK` 就算数——判据要的是"页面在不在"，不是"它的头写得规不规范"。
 *
 * 跑法：
 *   node scripts/check-platform-sources.mjs            # 真抓（默认）
 *   node scripts/check-platform-sources.mjs --offline  # 只列清单
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKS = join(ROOT, "packs", "platforms");
const OFFLINE = process.argv.includes("--offline");
const TIMEOUT_MS = 15000;

/** 包里两种文件各管各的字段；来源登记在两种文件里都有，所以两种都扫 */
const PACK_FILES = ["platform-spec.yaml", "platform-export.yaml"];

/** 从出处字符串里取出第一个链接（出处写成「URL —— 条款定位」的样子） */
function firstUrl(text) {
  const match = /https?:\/\/[^\s，。；、）】"'<>]+/.exec(text);
  return match === null ? null : match[0];
}

/**
 * 极简 YAML 取值：只要 `source_urls` 列表与每条规则的 `source` 字段。
 * 列表里允许夹注释行（真实的包里就是这么写的）——第一版没允许，
 * 结果七猫的 source_urls 一条都没抽出来（清单为空 = 看起来"没有出处"）。
 */
function collectUrls(text) {
  const urls = [];
  const lines = text.split(/\r?\n/);
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inList) {
      if (/^source_urls:\s*$/.test(trimmed)) {
        inList = true;
        continue;
      }
      if (trimmed.startsWith("source:")) {
        const url = firstUrl(trimmed);
        if (url !== null) urls.push({ url, from: "rule.source" });
      }
      continue;
    }
    // 列表块里：注释行跳过，列表项收链接，遇到别的顶层键就收工
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const item = /^-\s+(.*)$/.exec(trimmed);
    if (item !== null) {
      const url = firstUrl(item[1]);
      if (url !== null) urls.push({ url, from: "source_urls" });
      continue;
    }
    inList = false;
  }
  return urls;
}

/** 兜底：原始 TLS 连接读状态行（只认第一行，不解析头） */
function rawStatus(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status, note) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* 已经断了就算了 */
      }
      resolve({ ok: status >= 200 && status < 400, status, note });
    };
    const target = new URL(url);
    const port = target.port === "" ? 443 : Number(target.port);
    const socket = connect(
      { host: target.hostname, port, servername: target.hostname, timeout: TIMEOUT_MS },
      () => {
        const path = `${target.pathname}${target.search}`;
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: yushu-platform-source-check/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const index = buffer.indexOf("\r\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      const matched = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line);
      if (matched === null) {
        finish(0, `状态行无法解析：${line.slice(0, 80)}`);
        return;
      }
      const status = Number(matched[1]);
      finish(status, status === 0 ? "" : "（响应头不合规，按原始状态行核对）");
    });
    socket.on("error", (err) => finish(0, err.message));
    socket.on("timeout", () => finish(0, "超时"));
  });
}

async function check(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "yushu-platform-source-check/1.0" },
    });
    return { ok: response.status >= 200 && response.status < 400, status: response.status, note: "" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = await rawStatus(url);
    if (fallback.status > 0) return fallback;
    return { ok: false, status: 0, note: reason };
  } finally {
    clearTimeout(timer);
  }
}

const entries = await readdir(PACKS, { withFileTypes: true }).catch(() => []);
const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const rows = [];
for (const dir of dirs) {
  for (const file of PACK_FILES) {
    const text = await readFile(join(PACKS, dir, file), "utf8").catch(() => null);
    if (text === null) continue;
    for (const item of collectUrls(text)) {
      rows.push({ pack: dir, file, url: item.url, from: item.from });
    }
  }
}

const checkedAt = new Date().toISOString().slice(0, 10);
console.log(`平台规则包来源核对｜核对日期 ${checkedAt}｜共 ${rows.length} 条出处`);
if (OFFLINE) {
  for (const row of rows) console.log(`  · ${row.pack}/${row.file} (${row.from}) ${row.url}`);
  console.log("（--offline：只列清单，没真抓）");
  process.exit(0);
}

let bad = 0;
for (const row of rows) {
  const result = await check(row.url);
  if (!result.ok) bad += 1;
  const flag = result.ok ? "通 " : "不通";
  console.log(
    `  ${flag} ${row.pack}/${row.file} (${row.from}) ${result.status === 0 ? "连不上" : result.status} ${row.url}${
      result.note === "" ? "" : ` —— ${result.note}`
    }`,
  );
}
console.log(`核不到 ${bad} 条 / 共 ${rows.length} 条`);
process.exit(bad === 0 ? 0 : 1);
