import { runBash, type ToolArgs } from "./tools.js";

// ── s13: Background Tasks — 慢操作丢后台，不阻塞主循环 ──
//   Node 单线程事件循环本质："后台" 就是 "不 await"。fire-and-forget
//   执行 bash，完成后存入结果，下一轮以 <task_notification> 注入。

export interface BackgroundTask {
  bg_id: string;
  command: string;
  status: "running" | "completed";
  output: string;
}

const backgroundTasks = new Map<string, BackgroundTask>();
const backgroundResults = new Map<string, string>();
let bgCounter = 0;

const SLOW_KEYWORDS = [
  "install", "build", "test", "deploy", "compile", "docker build",
  "pip install", "npm install", "cargo build", "pytest", "make",
  "run", "dev", "serve", "watch", "start",
];

export function isSlowOperation(toolName: string, args: ToolArgs): boolean {
  if (toolName !== "bash") return false;
  const cmd = String(args.command ?? "").toLowerCase();
  return SLOW_KEYWORDS.some((kw) => cmd.includes(kw));
}

// 模型显式请求优先；否则启发式兜底
export function shouldRunBackground(toolName: string, args: ToolArgs): boolean {
  if (args.run_in_background === true) return true;
  return isSlowOperation(toolName, args);
}

// 后台执行 bash：不 await，完成回调存入结果
export function startBackgroundTask(_name: string, args: ToolArgs): string {
  bgCounter += 1;
  const bgId = `bg_${bgCounter.toString().padStart(4, "0")}`;
  const command = String(args.command ?? "");
  backgroundTasks.set(bgId, { bg_id: bgId, command, status: "running", output: "" });
  void runBash(command).then((output) => {
    backgroundTasks.set(bgId, { bg_id: bgId, command, status: "completed", output });
    backgroundResults.set(bgId, output);
  });
  return bgId;
}

// 收集已完成的后台结果，格式化为 <task_notification>
export function collectBackgroundResults(): string[] {
  const notifications: string[] = [];
  for (const [bgId, task] of backgroundTasks) {
    if (task.status !== "completed") continue;
    backgroundTasks.delete(bgId);
    const output = backgroundResults.get(bgId) ?? "";
    backgroundResults.delete(bgId);
    const summary = output.length > 200 ? output.slice(0, 200) : output;
    notifications.push(
      `<task_notification>\n  <task_id>${bgId}</task_id>\n  ` +
        `<status>completed</status>\n  <command>${task.command}</command>\n  ` +
        `<summary>${summary}</summary>\n</task_notification>`,
    );
  }
  return notifications;
}
