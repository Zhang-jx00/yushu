#!/usr/bin/env node
/**
 * 御书试跑用「本地模拟 LLM」：OpenAI Chat Completions 兼容（含 SSE 流式）。
 *
 * 用途：真人试跑（docs/07-真人试跑材料包.md）时，测试者无需真实 API Key 与网络，
 *       即可完整体验「AI 副驾 → 流式生成 → 采纳」流程。
 *
 * 用法：
 *   node scripts/mock-llm.mjs                 # 默认端口 11434
 *   node scripts/mock-llm.mjs --port 18080 --delay 30
 *
 * 配置（二选一）：
 *   A. 项目内 config/llm.yaml（推荐，写一次永久生效）：
 *        apiVersion: yushu.llm/v1
 *        format_version: 1
 *        providers:
 *          - id: local-mock
 *            kind: openai-compatible
 *            base_url: http://127.0.0.1:11434/v1
 *            model: mock-novelist
 *   B. AI 副驾面板：base_url 填 http://127.0.0.1:11434/v1、model 填 mock-novelist、
 *      API Key 环境变量名留空（无鉴权）。
 *
 * 说明：本脚本仅监听 127.0.0.1，返回固定示例正文（便于观察流式与字数对账），
 *       不调用任何外部服务，不写入磁盘。
 */

import { createServer } from "node:http";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = args.find((item) => item.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const port = Number.parseInt(argValue("port", "11434"), 10);
const delay = Number.parseInt(argValue("delay", "35"), 10);

/** 固定示例正文：分块流式返回，末尾含一段可选敏感词演示（默认不返回） */
const CHUNKS = [
  "天启界的夜色压下来，",
  "边城的灯火像被风吹散的星子。",
  "林渊立在石阶尽头，掌心那道被夺去的剑痕隐隐发烫——",
  "他忽然明白，灵气潮汐正沿着旧河道倒灌回城。",
  "远处钟声一响，街头卖炭的老人抬起头：",
  "“今晚的灵气，比三年前那一夜更重。”",
  "他没说话，只是把粗布衣袖拢紧，转身向藏经阁走去。",
];

let requestSeq = 0;

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found（mock-llm 仅实现 /v1/chat/completions）" } }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }
    requestSeq += 1;
    const id = `mock-${requestSeq}`;
    const model = typeof body.model === "string" ? body.model : "mock-novelist";
    console.log(
      `[mock-llm] #${requestSeq} model=${model} stream=${body.stream === true} messages=${Array.isArray(body.messages) ? body.messages.length : 0}`,
    );

    if (body.stream !== true) {
      const content = CHUNKS.join("");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 128, completion_tokens: content.length, total_tokens: 128 + content.length },
        }),
      );
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let index = 0;
    const writeNext = () => {
      if (index >= CHUNKS.length) {
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 128, completion_tokens: CHUNKS.join("").length, total_tokens: 128 + CHUNKS.join("").length },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sseWrite(res, {
        id,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content: CHUNKS[index] }, finish_reason: null }],
      });
      index += 1;
      setTimeout(writeNext, delay);
    };
    writeNext();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-llm] 已启动：http://127.0.0.1:${port}/v1（OpenAI 兼容，仅本机可访问）`);
  console.log("[mock-llm] config/llm.yaml 示例：");
  console.log("  apiVersion: yushu.llm/v1");
  console.log("  format_version: 2");
  console.log("  providers:");
  console.log("    - id: local-mock");
  console.log("      kind: local");
  console.log("      protocol: openai_chat");
  console.log(`      base_url: http://127.0.0.1:${port}/v1`);
  console.log("      models:");
  console.log("        - {name: mock-novelist, tier: flagship}");
  console.log("[mock-llm] 按 Ctrl+C 停止");
});