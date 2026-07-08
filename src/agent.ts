import type OpenAI from "openai";
import { client, MODEL, SYSTEM, TOOLS } from "./config.js";
import { runBash } from "./tools.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ── 核心模式：一个 while 循环，持续调用工具直到模型停止 ──
export async function agentLoop(messages: Msg[]): Promise<void> {
  const system: Msg = { role: "system", content: SYSTEM };

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [system, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const assistantMessage = response.choices[0].message;

    // 追加 assistant 回合（包含可能的 tool_calls）
    messages.push(assistantMessage as Msg);

    // 模型没有调用工具，结束
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return;
    }

    // 执行每个工具调用，收集结果
    const results: Msg[] = [];
    for (const tc of assistantMessage.tool_calls) {
      if (tc.type !== "function") continue;
      if (tc.function.name === "bash") {
        const args = JSON.parse(tc.function.arguments || "{}");
        console.log(`\x1b[33m$ ${args.command}\x1b[0m`);
        const output = await runBash(args.command);
        console.log(output.slice(0, 200));
        results.push({
          role: "tool",
          tool_call_id: tc.id,
          content: output,
        } as Msg);
      }
    }

    // 将工具结果喂回，循环继续
    messages.push(...results);
  }
}
