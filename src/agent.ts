import type OpenAI from "openai";
import { client, MODEL, TOOLS } from "./config.js";
import "./subagent.js"; // 自注册 task 工具
import { dispatchTool, type ToolArgs } from "./tools.js";
import { triggerHooks, type ToolCallInfo } from "./hooks.js";
import { shouldNag, resetNag, bumpNag } from "./todo.js";
import {
  preCompact,
  needsCompact,
  compactHistory,
  reactiveCompact,
  COMPACT_TOOL_RESULT,
} from "./context.js";
import { agentSystemPrompt } from "./system.js";
import { loadMemories, extractMemories, consolidateMemories } from "./memory.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MAX_REACTIVE_RETRIES = 1;

// ── 核心模式：一个 while 循环，持续调用工具直到模型停止 ──
export async function agentLoop(messages: Msg[]): Promise<void> {
  let reactiveRetries = 0;

  while (true) {
    // s05: nag 提醒 —— 连续 3 轮没更新 todo 就注入一条提醒
    if (shouldNag() && messages.length) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" } as Msg);
      resetNag();
    }

    // s08: 三层便宜预处理（0 次 API 调用），就地替换
    const compacted = preCompact(messages);
    messages.length = 0;
    messages.push(...compacted);

    // s08: 仍超阈值 → LLM 全文摘要（1 次 API 调用）
    if (needsCompact(messages)) {
      console.log("[auto compact]");
      const c = await compactHistory(messages);
      messages.length = 0;
      messages.push(...c);
    }

    // s09: 组合系统提示（技能目录 + 记忆索引），并把相关记忆注入到最新 user 回合
    const systemMsg: Msg = { role: "system", content: agentSystemPrompt() };
    const mem = await loadMemories(messages);
    let requestMessages: Msg[];
    if (mem && messages.length) {
      const copy = messages.map((m) => ({ ...m }));
      const last = copy[copy.length - 1];
      if (last.role === "user" && typeof last.content === "string") {
        last.content = `${mem}\n\n${last.content}`;
      }
      requestMessages = [systemMsg, ...copy];
    } else {
      requestMessages = [systemMsg, ...messages];
    }

    // LLM 调用（外层可能触发 reactive compact）
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages: requestMessages,
        tools: TOOLS,
        max_tokens: 8000,
      });
      reactiveRetries = 0; // 调用成功则重置
    } catch (e: any) {
      const errMsg = String(e?.message ?? e).toLowerCase();
      if (
        (errMsg.includes("maximum context") ||
          errMsg.includes("too long") ||
          errMsg.includes("tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        console.log("[reactive compact]");
        const rc = await reactiveCompact(messages);
        messages.length = 0;
        messages.push(...rc);
        reactiveRetries++;
        continue;
      }
      throw e;
    }

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
      // s09: 回合结束 → 抽取并整合记忆
      await extractMemories(messages);
      await consolidateMemories();
      return;
    }

    // s05: 每轮有工具调用就 +1（todo_write 时由工具自身重置）
    bumpNag();

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

      // s08: compact 工具 —— 触发全文摘要并开启新一轮
      if (name === "compact") {
        const c = await compactHistory(messages);
        messages.length = 0;
        messages.push(...c);
        results.push({ role: "tool", tool_call_id: tc.id, content: COMPACT_TOOL_RESULT } as Msg);
        break;
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
      if (name === "todo_write") resetNag(); // s05: 调用 todo_write 重置 nag
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
