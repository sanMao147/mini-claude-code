import type OpenAI from "openai";
import { agentLoop } from "./agent.js";
import { provider, BASE_URL, MODEL } from "./config.js";
import { ask, closeInput } from "./input.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ── 入口：交互式 REPL ──────────────────────────────
async function main(): Promise<void> {
  console.log("mini-claude-code: Agent Loop (+ tools / permission)");
  console.log(`服务商: ${provider}  |  模型: ${MODEL}`);
  console.log(`接口: ${BASE_URL}\n`);
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: Msg[] = [];

  try {
    while (true) {
      const query = (await ask("\x1b[36mmcc >> \x1b[0m")).trim();
      if (["q", "exit"].includes(query.toLowerCase())) break;
      if (query === "") continue;

      history.push({ role: "user", content: query });
      await agentLoop(history);

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
    closeInput();
  }
}

main();
