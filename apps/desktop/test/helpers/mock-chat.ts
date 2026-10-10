import { createServer, type Server } from "node:http";

/**
 * 固定回答的 OpenAI 兼容 mock（非流式）。
 *
 * 放在 test/helpers 而不是各测试文件里：抽取式结构化输出（`chat` 通道）的桩在
 * AI 采样与"采样结论并入体检报告"两处都要用，各写一份就会漂出两种"模型行为"。
 */
const servers: Server[] = [];

export async function startReplyMock(reply: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/v1`;
}

export async function closeAllMocks(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}
