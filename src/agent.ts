import type OpenAI from "openai";
import { client, MODEL, FALLBACK_MODEL, TOOLS } from "./config.js";
import "./subagent.js"; // 自注册 task 工具
import "./tasks.js"; // 自注册 create_task/list_tasks/get_task/claim_task/complete_task
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
import { getSystemPrompt, updateContext } from "./system.js";
import { loadMemories, extractMemories, consolidateMemories } from "./memory.js";
import {
  newRecoveryState,
  withRetry,
  isPromptTooLongError,
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
  CONTINUATION_PROMPT,
} from "./errors.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ── 核心模式：一个 while 循环，持续调用工具直到模型停止 ──
export async function agentLoop(messages: Msg[]): Promise<void> {
  // s11: 跨循环的错误恢复状态
  const state = newRecoveryState(MODEL);
  let maxTokens = DEFAULT_MAX_TOKENS;

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

    // s10: 按真实状态组装系统提示（分段 + 缓存），并把相关记忆注入到最新 user 回合
    const systemMsg: Msg = { role: "system", content: getSystemPrompt(updateContext()) };
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

    // LLM 调用：withRetry 处理 429/529，外层处理 prompt_too_long 等
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await withRetry(
        () =>
          client.chat.completions.create({
            model: state.current_model,
            messages: requestMessages,
            tools: TOOLS,
            max_tokens: maxTokens,
          }),
        state,
        FALLBACK_MODEL,
      );
    } catch (e: any) {
      // 路径 2: prompt_too_long → 响应式压缩（仅一次）
      if (isPromptTooLongError(e)) {
        if (!state.has_attempted_reactive_compact) {
          state.has_attempted_reactive_compact = true;
          const rc = await reactiveCompact(messages);
          messages.length = 0;
          messages.push(...rc);
          continue;
        }
        console.log("  \x1b[31m[unrecoverable] still too long after compact\x1b[0m");
        messages.push({ role: "assistant", content: "[Error] Context too large, cannot continue." } as Msg);
        return;
      }
      const name = e?.constructor?.name ?? "Error";
      console.log(`  \x1b[31m[unrecoverable] ${name}: ${String(e?.message ?? e).slice(0, 100)}\x1b[0m`);
      messages.push({ role: "assistant", content: `[Error] ${name}: ${String(e?.message ?? e).slice(0, 200)}` } as Msg);
      return;
    }

    const assistantMessage = response.choices[0].message;

    // 路径 1: 输出被截断（finish_reason === "length"）
    if (response.choices[0].finish_reason === "length") {
      if (!state.has_escalated) {
        // 首次：升级 token 上限，重放同一请求（不追加截断输出）
        maxTokens = ESCALATED_MAX_TOKENS;
        state.has_escalated = true;
        console.log(`  \x1b[33m[max_tokens] escalating ${DEFAULT_MAX_TOKENS} -> ${ESCALATED_MAX_TOKENS}\x1b[0m`);
        continue;
      }
      // 64K 仍截断：保存截断输出 + 续写提示（最多 MAX_RECOVERY_RETRIES 次）
      messages.push(assistantMessage as Msg);
      if (state.recovery_count < MAX_RECOVERY_RETRIES) {
        messages.push({ role: "user", content: CONTINUATION_PROMPT } as Msg);
        state.recovery_count += 1;
        console.log(`  \x1b[33m[max_tokens] continuation ${state.recovery_count}/${MAX_RECOVERY_RETRIES}\x1b[0m`);
        continue;
      }
      console.log("  \x1b[31m[max_tokens] recovery limit reached\x1b[0m");
      return;
    }

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
