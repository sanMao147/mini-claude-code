import type OpenAI from "openai";
import { client, MODEL, SYSTEM, TOOLS } from "./config.js";
import { dispatchTool, type ToolArgs } from "./tools.js";
import { triggerHooks, type ToolCallInfo } from "./hooks.js";

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

    // 模型没有调用工具
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      // s04: Stop 钩子（返回值 ≠ null 强制续跑）
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force } as Msg);
        continue;
      }
      return;
    }

    // 执行每个工具调用，收集结果
    const results: Msg[] = [];
    for (const tc of assistantMessage.tool_calls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      let args: ToolArgs;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      console.log(`\x1b[33m$ ${name}\x1b[0m`);

      // s04: PreToolUse 钩子（权限等）；返回值 ≠ null → 阻止执行
      const blocked = await triggerHooks("PreToolUse", { name, args } as ToolCallInfo);
      if (blocked) {
        results.push({
          role: "tool",
          tool_call_id: tc.id,
          content: blocked,
        } as Msg);
        continue;
      }

      // s02: 查表分发到具体 handler
      const output = await dispatchTool(name, args);
      console.log(output.slice(0, 200));

      // s04: PostToolUse 钩子（日志/副作用）
      await triggerHooks("PostToolUse", { name, output });

      results.push({
        role: "tool",
        tool_call_id: tc.id,
        content: output,
      } as Msg);
    }

    // 将工具结果喂回，循环继续
    messages.push(...results);
  }
}
