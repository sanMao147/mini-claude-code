import type OpenAI from "openai";
import { agentLoop } from "./agent.js";
import { provider, BASE_URL, MODEL } from "./config.js";
import { ask, closeInput } from "./input.js";
import { triggerHooks } from "./hooks.js";
import { startScheduler, hasCronQueue } from "./cron.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ── 入口：交互式 REPL ──────────────────────────────
async function main(): Promise<void> {
  console.log("mini-claude-code: Agent Loop (+ tools / hooks)");
  console.log(`服务商: ${provider}  |  模型: ${MODEL}`);
  console.log(`接口: ${BASE_URL}\n`);

  // s14: 启动 cron 调度器（独立轮询线程）
  startScheduler();
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: Msg[] = [];
  let busy = false;

  // s14: 队列处理器 —— agent 空闲且有待投递的 cron 任务时自动跑一轮
  const queueProcessor = setInterval(async () => {
    if (busy || !hasCronQueue()) return;
    busy = true;
    try {
      console.log("\n  \x1b[35m[queue processor] delivering scheduled work\x1b[0m");
      await agentLoop(history);
      const last = history[history.length - 1];
      if (last.role === "assistant" && typeof last.content === "string") {
        console.log(last.content);
      }
    } catch (err) {
      console.error("\n[cron turn] 错误：", err);
    } finally {
      busy = false;
    }
  }, 200);

  try {
    while (true) {
      const query = (await ask("\x1b[36mmcc >> \x1b[0m")).trim();
      if (["q", "exit"].includes(query.toLowerCase())) break;
      if (query === "") continue;

      // s04: UserPromptSubmit 钩子（进入 LLM 前）
      await triggerHooks("UserPromptSubmit", query);

      busy = true;
      history.push({ role: "user", content: query });
      await agentLoop(history);
      busy = false;

      // 打印模型最终的文本回复
      const last = history[history.length - 1];
      if (last.role === "assistant" && typeof last.content === "string") {
        console.log(last.content);
      }
      console.log();
    }
  } catch (err) {
    console.error("\n发生错误：", err);
  } finally {
    clearInterval(queueProcessor);
    closeInput();
  }
}

main();
