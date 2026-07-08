import * as fs from "node:fs";
import * as path from "node:path";
import type OpenAI from "openai";
import { client, MODEL } from "./config.js";
import { TOOL_HANDLERS, runBash, runRead, runWrite, type ToolArgs } from "./tools.js";

// ── s15: Agent Teams — MessageBus + 后台 teammate + lead 收件箱注入 ──
//   教学版：teammate 用后台 async 函数（最多 10 轮），结果经 MessageBus 回 lead。

const MAILBOX_DIR = path.resolve(process.cwd(), ".mailboxes");
function ensureMailboxDir(): void {
  fs.mkdirSync(MAILBOX_DIR, { recursive: true });
}

export class MessageBus {
  send(from: string, to: string, content: string, type = "message"): void {
    ensureMailboxDir();
    const msg = { from, to, content, type, ts: Date.now() };
    fs.appendFileSync(path.join(MAILBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    console.log(`  \x1b[33m[bus] ${from} → ${to}: ${content.slice(0, 50)}\x1b[0m`);
  }
  readInbox(agent: string): Array<Record<string, unknown>> {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const lines = fs.readFileSync(inbox, "utf8").split(/\r?\n/).filter(Boolean);
    const msgs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.unlinkSync(inbox); // 消费即删除
    return msgs;
  }
  peek(agent: string): boolean {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    return fs.existsSync(inbox) && fs.statSync(inbox).size > 0;
  }
}

export const BUS = new MessageBus();
const activeTeammates = new Set<string>();

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// teammate 只有 4 个工具（不含 task，避免递归）
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
      name: "send_message",
      description: "Send a message to another agent.",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, content: { type: "string" } },
        required: ["to", "content"],
      },
    },
  },
];

// teammate 主循环（后台 async，最多 10 轮）
async function teammateRun(name: string, role: string, prompt: string): Promise<void> {
  const system = `You are '${name}', a ${role}. Use tools to complete tasks. Send results via send_message to 'lead'.`;
  const messages: Msg[] = [{ role: "user", content: prompt }];
  const handlers: Record<string, (a: ToolArgs) => string | Promise<string>> = {
    bash: (a) => runBash(String(a.command)),
    read_file: runRead,
    write_file: runWrite,
    send_message: (a) => {
      BUS.send(name, String(a.to), String(a.content));
      return "Sent";
    },
  };

  for (let i = 0; i < 10; i++) {
    const inbox = BUS.readInbox(name);
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` } as Msg);
    }
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages: messages.slice(-40),
        tools: SUB_TOOLS,
        max_tokens: 8000,
      });
    } catch {
      break;
    }
    messages.push(response.choices[0].message as Msg);
    const msg = response.choices[0].message;
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    const results: Msg[] = [];
    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      let args: ToolArgs = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }
      const h = handlers[tc.function.name];
      const out = h ? await h(args) : `Unknown: ${tc.function.name}`;
      results.push({ role: "tool", tool_call_id: tc.id, content: String(out) } as Msg);
    }
    messages.push(...results);
  }

  // 收尾：把最终文本摘要发回 lead
  let summary = "Done.";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      summary = m.content;
      break;
    }
  }
  BUS.send(name, "lead", summary, "result");
  activeTeammates.delete(name);
  console.log(`  \x1b[32m[teammate] ${name} finished\x1b[0m`);
}

export function spawnTeammate(name: string, role: string, prompt: string): string {
  if (activeTeammates.has(name)) return `Teammate '${name}' already exists`;
  activeTeammates.add(name);
  void teammateRun(name, role, prompt);
  console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`);
  return `Teammate '${name}' spawned as ${role}`;
}

export function runSendMessage(args: ToolArgs): string {
  BUS.send("lead", String(args.to), String(args.content));
  return `Sent to ${args.to}`;
}

export function runCheckInbox(): string {
  const msgs = BUS.readInbox("lead");
  if (!msgs.length) return "(inbox empty)";
  return msgs.map((m) => `  [${m.from}] ${String(m.content).slice(0, 200)}`).join("\n");
}

// agent.ts 循环顶部消费 lead 收件箱（破坏性），用于注入
export function consumeLeadInbox(): Array<Record<string, unknown>> {
  return BUS.readInbox("lead");
}

export function hasPendingInbox(): boolean {
  return BUS.peek("lead");
}

export function allTeammatesDone(): boolean {
  return activeTeammates.size === 0;
}

// 自注册 lead 团队工具
TOOL_HANDLERS.set("spawn_teammate", (a) =>
  spawnTeammate(String(a.name), String(a.role), String(a.prompt)),
);
TOOL_HANDLERS.set("send_message", runSendMessage);
TOOL_HANDLERS.set("check_inbox", runCheckInbox);
