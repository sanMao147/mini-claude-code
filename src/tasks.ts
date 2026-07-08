import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_HANDLERS, type ToolArgs } from "./tools.js";

// ── s12: Task System — 文件持久化的任务图，blockedBy 依赖 ──
//   每个任务一个 .tasks/{id}.json；claim/complete 改变状态并解锁下游。
//   与 s05 TodoWrite 是两套独立系统（本版并存）。

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
}

const TASKS_DIR = path.resolve(process.cwd(), ".tasks");

function ensureDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function taskPath(id: string): string {
  return path.join(TASKS_DIR, `${id}.json`);
}

export function createTask(subject: string, description = "", blockedBy: string[] = []): Task {
  ensureDir();
  const id = `task_${Date.now()}_${Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0")}`;
  const task: Task = { id, subject, description, status: "pending", owner: null, blockedBy };
  saveTask(task);
  return task;
}

export function saveTask(task: Task): void {
  ensureDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2));
}

export function loadTask(id: string): Task {
  const raw = fs.readFileSync(taskPath(id), "utf8");
  return JSON.parse(raw) as Task;
}

export function listTasks(): Task[] {
  ensureDir();
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Task);
}

export function getTask(id: string): string {
  return JSON.stringify(loadTask(id), null, 2);
}

// 所有 blockedBy 依赖都 completed 才可开始；缺失依赖视为 blocked
export function canStart(id: string): boolean {
  const task = loadTask(id);
  for (const dep of task.blockedBy) {
    if (!fs.existsSync(taskPath(dep))) return false;
    if (loadTask(dep).status !== "completed") return false;
  }
  return true;
}

export function claimTask(id: string, owner = "agent"): string {
  const task = loadTask(id);
  if (task.status !== "pending") return `Task ${id} is ${task.status}, cannot claim`;
  if (!canStart(id)) {
    const blocked = task.blockedBy.filter(
      (d) => !fs.existsSync(taskPath(d)) || loadTask(d).status !== "completed",
    );
    return `Blocked by: ${blocked.join(", ")}`;
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  return `Claimed ${task.id} (${task.subject}, owner: ${owner})`;
}

export function completeTask(id: string): string {
  const task = loadTask(id);
  if (task.status !== "in_progress") return `Task ${id} is ${task.status}, cannot complete`;
  task.status = "completed";
  saveTask(task);
  const unblocked = listTasks()
    .filter((t) => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id))
    .map((t) => t.subject);
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) msg += `\nUnblocked: ${unblocked.join(", ")}`;
  return msg;
}

// ── 工具 handler ──

function runCreateTask(args: ToolArgs): string {
  const subject = String(args.subject ?? "");
  const description = String(args.description ?? "");
  const blockedBy = Array.isArray(args.blockedBy) ? args.blockedBy.map(String) : [];
  const t = createTask(subject, description, blockedBy);
  const deps = blockedBy.length ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  return `Created ${t.id}: ${t.subject}${deps}`;
}

function runListTasks(_args: ToolArgs): string {
  const tasks = listTasks();
  if (!tasks.length) return "No tasks. Use create_task to add some.";
  const icon: Record<TaskStatus, string> = { pending: "○", in_progress: "●", completed: "✓" };
  return tasks
    .map((t) => {
      const deps = t.blockedBy.length ? ` (blockedBy: ${t.blockedBy.join(", ")})` : "";
      const owner = t.owner ? ` [${t.owner}]` : "";
      return `  ${icon[t.status]} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}`;
    })
    .join("\n");
}

function runGetTask(args: ToolArgs): string {
  const id = String(args.task_id ?? "");
  try {
    return getTask(id);
  } catch {
    return `Error: Task ${id} not found`;
  }
}

function runClaimTask(args: ToolArgs): string {
  return claimTask(String(args.task_id ?? ""), "agent");
}

function runCompleteTask(args: ToolArgs): string {
  return completeTask(String(args.task_id ?? ""));
}

// 自注册 5 个任务工具
TOOL_HANDLERS.set("create_task", runCreateTask);
TOOL_HANDLERS.set("list_tasks", runListTasks);
TOOL_HANDLERS.set("get_task", runGetTask);
TOOL_HANDLERS.set("claim_task", runClaimTask);
TOOL_HANDLERS.set("complete_task", runCompleteTask);
