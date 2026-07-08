import type OpenAI from "openai";
import { client, MODEL } from "./config.js";
import {
  runBash,
  runRead,
  runWrite,
  runEdit,
  runGlob,
  TOOL_HANDLERS,
  type ToolArgs,
} from "./tools.js";
import { triggerHooks } from "./hooks.js";

// ── s06: Subagent — 用全新 messages[] 派生子代理，只回传摘要 ──
//   子代理的工具集不含 task，避免递归派生子-子代理。

const SUB_SYSTEM = `You are a coding agent at ${process.cwd()}. Complete the task you were given, then return a concise summary. Do not delegate further.`;

// 子代理工具：bash / read / write / edit / glob（无 task → 不递归）
const SUB_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in a file once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  },
];

const SUB_HANDLERS: Record<string, (a: ToolArgs) => string | Promise<string>> = {
  bash: (a) => runBash(String(a.command)),
  read_file: runRead,
  write_file: runWrite,
  edit_file: runEdit,
  glob: runGlob,
};

type SubMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function extractText(msg: SubMsg): string {
  if (msg.role === "assistant" && typeof msg.content === "string") return msg.content;
  return "";
}

export async function spawnSubagent(description: string): Promise<string> {
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);
  const messages: SubMsg[] = [
    { role: "system", content: SUB_SYSTEM },
    { role: "user", content: description }, // 全新上下文
  ];

  for (let i = 0; i < 30; i++) {
    // 安全上限：每个子代理最多 30 轮
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: SUB_TOOLS,
      max_tokens: 8000,
    });
    const a = response.choices[0].message;
    messages.push(a as SubMsg);

    if (!a.tool_calls || a.tool_calls.length === 0) break;

    const results: SubMsg[] = [];
    for (const tc of a.tool_calls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      let args: ToolArgs;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      // 子代理同样受权限钩子约束
      const blocked = await triggerHooks("PreToolUse", { name, args });
      if (blocked) {
        results.push({ role: "tool", tool_call_id: tc.id, content: String(blocked) } as SubMsg);
        continue;
      }

      const handler = SUB_HANDLERS[name];
      const output = handler ? await handler(args) : `Unknown tool: ${name}`;
      await triggerHooks("PostToolUse", { name, output });
      console.log(`  \x1b[90m[sub] ${name}: ${String(output).slice(0, 100)}\x1b[0m`);
      results.push({ role: "tool", tool_call_id: tc.id, content: output } as SubMsg);
    }
    messages.push(...results);
  }

  // 仅返回摘要：整个消息历史丢弃
  let result = extractText(messages[messages.length - 1]);
  if (!result) {
    for (let i = messages.length - 1; i >= 0; i--) {
      result = extractText(messages[i]);
      if (result) break;
    }
  }
  if (!result) result = "Subagent stopped after 30 turns without final answer.";
  console.log(`\x1b[35m[Subagent done]\x1b[0m`);
  return result;
}

// 自注册：父代理的 tools 加上 task
TOOL_HANDLERS.set("task", (a) => spawnSubagent(String(a.description)));
