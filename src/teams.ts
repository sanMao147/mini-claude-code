import * as fs from "node:fs";
import * as path from "node:path";
import type OpenAI from "openai";
import { client, MODEL } from "./config.js";
import { TOOL_HANDLERS, runBash, runRead, runWrite, type ToolArgs } from "./tools.js";
import { listTasks, claimTask, completeTask, canStart, type Task } from "./tasks.js";

// ── s15/s16: Agent Teams — MessageBus + 协议(请求/响应) + 后台 teammate ──

const MAILBOX_DIR = path.resolve(process.cwd(), ".mailboxes");
function ensureMailboxDir(): void {
  fs.mkdirSync(MAILBOX_DIR, { recursive: true });
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── s17: 自主循环 — 空闲轮询 + 自动认领任务 ──
const IDLE_POLL_INTERVAL = 5000; // ms (5s)
const IDLE_TIMEOUT = 60000;       // ms (60s)

// 找出 pending、无 owner、且依赖已完成的任务
function scanUnclaimedTasks(): Task[] {
  return listTasks().filter((t) => t.status === "pending" && !t.owner && canStart(t.id));
}

// IDLE 阶段轮询：检查收件箱/任务板，返回 "work" | "shutdown" | "timeout"
async function idlePoll(name: string, messages: Msg[]): Promise<"work" | "shutdown" | "timeout"> {
  const iterations = Math.floor(IDLE_TIMEOUT / IDLE_POLL_INTERVAL);
  for (let i = 0; i < iterations; i++) {
    await sleep(IDLE_POLL_INTERVAL);

    const inbox = BUS.readInbox(name);
    if (inbox.length) {
      // 优先处理 shutdown_request
      for (const msg of inbox) {
        if (String(msg.type ?? "") === "shutdown_request") {
          const reqId = String((msg.metadata as Record<string, unknown>)?.request_id ?? "");
          BUS.send(name, "lead", "Shutting down gracefully.", "shutdown_response", {
            request_id: reqId,
            approve: true,
          });
          console.log(`  \x1b[35m[protocol] ${name} approved shutdown in idle (${reqId})\x1b[0m`);
          return "shutdown";
        }
      }
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` } as Msg);
      console.log(`  \x1b[36m[idle] ${name} found inbox messages\x1b[0m`);
      return "work";
    }

    // 扫描任务板：自动认领无人认领的任务
    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length) {
      const task = unclaimed[0];
      const result = claimTask(task.id, name);
      if (result.includes("Claimed")) {
        messages.push({
          role: "user",
          content: `<auto-claimed>Task ${task.id}: ${task.subject}</auto-claimed>`,
        } as Msg);
        console.log(`  \x1b[32m[idle] ${name} auto-claimed: ${task.subject}\x1b[0m`);
        return "work";
      }
      console.log(`  \x1b[33m[idle] ${name} claim failed: ${result}\x1b[0m`);
    }
  }
  console.log(`  \x1b[31m[idle] ${name} timeout (${IDLE_TIMEOUT / 1000}s)\x1b[0m`);
  return "timeout";
}

export class MessageBus {
  send(
    from: string,
    to: string,
    content: string,
    type = "message",
    metadata: Record<string, unknown> = {},
  ): void {
    ensureMailboxDir();
    const msg = { from, to, content, type, ts: Date.now(), metadata };
    fs.appendFileSync(path.join(MAILBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    console.log(`  \x1b[33m[bus] ${from} → ${to}: (${type}) ${content.slice(0, 50)}\x1b[0m`);
  }
  readInbox(agent: string): Array<Record<string, unknown>> {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const lines = fs.readFileSync(inbox, "utf8").split(/\r?\n/).filter(Boolean);
    const msgs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    fs.unlinkSync(inbox);
    return msgs;
  }
  peek(agent: string): boolean {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    return fs.existsSync(inbox) && fs.statSync(inbox).size > 0;
  }
}

export const BUS = new MessageBus();
const activeTeammates = new Set<string>();

// ── s16: 协议状态（request_id 关联请求与响应）──
export interface ProtocolState {
  request_id: string;
  type: "shutdown" | "plan_approval";
  sender: string;
  target: string;
  status: "pending" | "approved" | "rejected";
  payload: string;
}

const pendingRequests = new Map<string, ProtocolState>();

function newRequestId(): string {
  return `req_${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`;
}

function matchResponse(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests.get(requestId);
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return;
  }
  if (state.type === "shutdown" && responseType !== "shutdown_response") {
    console.log(`  \x1b[31m[protocol] type mismatch: expected shutdown_response, got ${responseType}\x1b[0m`);
    return;
  }
  if (state.type === "plan_approval" && responseType !== "plan_approval_response") {
    console.log(`  \x1b[31m[protocol] type mismatch: expected plan_approval_response, got ${responseType}\x1b[0m`);
    return;
  }
  if (state.status !== "pending") {
    console.log(`  \x1b[33m[protocol] ${requestId} already ${state.status}, ignoring\x1b[0m`);
    return;
  }
  state.status = approve ? "approved" : "rejected";
  const icon = approve ? "✓" : "✗";
  const color = approve ? "32" : "31";
  console.log(`  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId}: ${state.status})\x1b[0m`);
}

// ── s16: 统一收件箱消费（路由协议响应 + 返回全部消息）──
export function consumeLeadInbox(): Array<Record<string, unknown>> {
  const msgs = BUS.readInbox("lead");
  if (!msgs.length) return [];
  for (const msg of msgs) {
    const meta = (msg.metadata as Record<string, unknown>) ?? {};
    const reqId = String(meta.request_id ?? "");
    const msgType = String(msg.type ?? "");
    if (reqId && msgType.endsWith("_response")) {
      const approve = Boolean(meta.approve);
      matchResponse(msgType, reqId, approve);
    }
  }
  return msgs;
}

export function hasPendingInbox(): boolean {
  return BUS.peek("lead");
}

// ── teammate 子工具 ──
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
  {
    type: "function",
    function: {
      name: "submit_plan",
      description: "Submit a plan for Lead approval.",
      parameters: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
    },
  },
  // s17: teammates can list / claim / complete tasks from the board
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List all tasks on the board.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "claim_task",
      description: "Claim a pending, unowned task by id.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Mark an in-progress task as completed.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    },
  },
];

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// teammate 收到 shutdown_request 时停止
function handleInboxMessage(name: string, msg: Record<string, unknown>, messages: Msg[]): boolean {
  const msgType = String(msg.type ?? "message");
  const meta = (msg.metadata as Record<string, unknown>) ?? {};
  const reqId = String(meta.request_id ?? "");
  if (msgType === "shutdown_request") {
    BUS.send(name, "lead", "Shutting down gracefully.", "shutdown_response", {
      request_id: reqId,
      approve: true,
    });
    console.log(`  \x1b[35m[protocol] ${name} approved shutdown (${reqId})\x1b[0m`);
    return true;
  }
  if (msgType === "plan_approval_response") {
    const approve = Boolean(meta.approve);
    if (approve) {
      messages.push({ role: "user", content: "[Plan approved] Proceed with the task." } as Msg);
    } else {
      messages.push({
        role: "user",
        content: `[Plan rejected] Feedback: ${String(msg.content ?? "")}`,
      } as Msg);
    }
  }
  return false;
}

async function teammateRun(name: string, role: string, prompt: string): Promise<void> {
  const system =
    `You are '${name}', a ${role}. Use tools to complete tasks. ` +
    `You can list and claim tasks from the board. ` +
    `Check inbox for protocol messages (shutdown_request, plan_approval_response).`;
  const messages: Msg[] = [{ role: "user", content: prompt }];
  const handlers: Record<string, (a: ToolArgs) => string | Promise<string>> = {
    bash: (a) => runBash(String(a.command)),
    read_file: runRead,
    write_file: runWrite,
    send_message: (a) => {
      BUS.send(name, String(a.to), String(a.content));
      return "Sent";
    },
    submit_plan: (a) => teammateSubmitPlan(name, String(a.plan)),
    list_tasks: () =>
      listTasks().map((t) => `  ${t.id}: ${t.subject} [${t.status}]`).join("\n") || "No tasks.",
    claim_task: (a) => claimTask(String(a.task_id), name),
    complete_task: (a) => completeTask(String(a.task_id)),
  };

  let shutdownRequested = false;
  // WORK → IDLE → SHUTDOWN 生命周期（s17）
  while (!shutdownRequested) {
    // 身份重注（s17）：上下文较短时提醒自己是谁
    if (messages.length <= 3) {
      messages.unshift({
        role: "user",
        content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>`,
      } as Msg);
    }

    // ── WORK 阶段：最多 10 轮工具循环 ──
    let workShutdown = false;
    for (let w = 0; w < 10; w++) {
      // 处理收件箱协议消息
      const inbox = BUS.readInbox(name);
      let shouldStop = false;
      const nonProtocol: Record<string, unknown>[] = [];
      for (const m of inbox) {
        const mt = String(m.type ?? "");
        if (mt === "shutdown_request" || mt === "plan_approval_response") {
          if (handleInboxMessage(name, m, messages)) {
            shouldStop = true;
            break;
          }
        } else {
          nonProtocol.push(m);
        }
      }
      if (shouldStop) {
        workShutdown = true;
        break;
      }
      if (nonProtocol.length) {
        messages.push({ role: "user", content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>` } as Msg);
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
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        break; // 没有工具调用 → 进入 IDLE
      }

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
    if (workShutdown) {
      shutdownRequested = true;
      break;
    }

    // ── IDLE 阶段：轮询收件箱/任务板 ──
    const idle = await idlePoll(name, messages);
    if (idle === "shutdown" || idle === "timeout") {
      break;
    }
    // idle === "work": 带着新消息回到 WORK 阶段
  }

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

function teammateSubmitPlan(fromName: string, plan: string): string {
  const reqId = newRequestId();
  pendingRequests.set(reqId, {
    request_id: reqId,
    type: "plan_approval",
    sender: fromName,
    target: "lead",
    status: "pending",
    payload: plan,
  });
  BUS.send(fromName, "lead", plan, "plan_approval_request", { request_id: reqId });
  return `Plan submitted (${reqId}). Waiting for approval...`;
}

export function spawnTeammate(name: string, role: string, prompt: string): string {
  if (activeTeammates.has(name)) return `Teammate '${name}' already exists`;
  activeTeammates.add(name);
  void teammateRun(name, role, prompt);
  console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`);
  return `Teammate '${name}' spawned as ${role}`;
}

// ── Lead 协议工具 ──
export function runRequestShutdown(teammate: string): string {
  const reqId = newRequestId();
  pendingRequests.set(reqId, {
    request_id: reqId,
    type: "shutdown",
    sender: "lead",
    target: teammate,
    status: "pending",
    payload: "",
  });
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", {
    request_id: reqId,
  });
  console.log(`  \x1b[35m[protocol] shutdown_request → ${teammate} (${reqId})\x1b[0m`);
  return `Shutdown request sent to ${teammate} (req: ${reqId})`;
}

export function runRequestPlan(teammate: string, task: string): string {
  BUS.send("lead", teammate, `Please submit a plan for: ${task}`, "message");
  return `Asked ${teammate} to submit a plan`;
}

export function runReviewPlan(requestId: string, approve: boolean, feedback = ""): string {
  const state = pendingRequests.get(requestId);
  if (!state) return `Request ${requestId} not found`;
  if (state.status !== "pending") return `Request ${requestId} already ${state.status}`;
  state.status = approve ? "approved" : "rejected";
  BUS.send("lead", state.sender, feedback || (approve ? "Approved" : "Rejected"),
    "plan_approval_response", { request_id: requestId, approve });
  console.log(`  \x1b[32m[protocol] plan ${approve ? "✓" : "✗"} (${requestId})\x1b[0m`);
  return `Plan ${approve ? "approved" : "rejected"} (${requestId})`;
}

export function runSendMessage(args: ToolArgs): string {
  BUS.send("lead", String(args.to), String(args.content));
  return `Sent to ${args.to}`;
}

export function runCheckInbox(): string {
  const msgs = consumeLeadInbox();
  if (!msgs.length) return "(inbox empty)";
  return msgs
    .map((m) => {
      const meta = (m.metadata as Record<string, unknown>) ?? {};
      const reqId = String(meta.request_id ?? "");
      const tag = reqId ? ` [${m.type} req:${reqId}]` : ` [${m.type}]`;
      return `  [${m.from}]${tag} ${String(m.content).slice(0, 200)}`;
    })
    .join("\n");
}

// ── 自注册 Lead 团队工具 ──
TOOL_HANDLERS.set("spawn_teammate", (a) =>
  spawnTeammate(String(a.name), String(a.role), String(a.prompt)),
);
TOOL_HANDLERS.set("send_message", runSendMessage);
TOOL_HANDLERS.set("check_inbox", runCheckInbox);
TOOL_HANDLERS.set("request_shutdown", (a) => runRequestShutdown(String(a.teammate)));
TOOL_HANDLERS.set("request_plan", (a) => runRequestPlan(String(a.teammate), String(a.task)));
TOOL_HANDLERS.set("review_plan", (a) =>
  runReviewPlan(String(a.request_id), a.approve === true, String(a.feedback ?? "")),
);
