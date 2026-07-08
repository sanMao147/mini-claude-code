import { TOOL_HANDLERS, type ToolArgs } from "./tools.js";

// ── s05: TodoWrite — plan before execute ──────────
//   一个只做规划的工具：把任务列表存在内存里并展示，不执行任何实际操作。

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo {
  content: string;
  status: TodoStatus;
}

export let CURRENT_TODOS: Todo[] = [];

// ── nag 提醒计数器：连续 3 轮没更新 todo 就注入提醒 ──
let roundsSinceTodo = 0;
export function resetNag(): void {
  roundsSinceTodo = 0;
}
export function bumpNag(): void {
  roundsSinceTodo += 1;
}
export function shouldNag(): boolean {
  return roundsSinceTodo >= 3;
}

function isValidTodo(v: any): v is Todo {
  return (
    v &&
    typeof v === "object" &&
    typeof v.content === "string" &&
    ["pending", "in_progress", "completed"].includes(v.status)
  );
}

export function runTodoWrite(args: ToolArgs): string {
  let todos: any = args.todos;
  if (typeof todos === "string") {
    try {
      todos = JSON.parse(todos);
    } catch {
      return "Error: todos must be a JSON array";
    }
  }
  if (!Array.isArray(todos)) return "Error: todos must be a list";
  for (let i = 0; i < todos.length; i++) {
    if (!isValidTodo(todos[i])) {
      return `Error: todos[${i}] missing 'content'/'status' or invalid status`;
    }
  }

  CURRENT_TODOS = todos as Todo[];
  resetNag();

  const icon: Record<TodoStatus, string> = {
    pending: " ",
    in_progress: "\x1b[36m▸\x1b[0m",
    completed: "\x1b[32m✓\x1b[0m",
  };
  const lines = ["\n\x1b[33m## Current Tasks\x1b[0m"];
  for (const t of CURRENT_TODOS) lines.push(`  [${icon[t.status]}] ${t.content}`);
  console.log(lines.join("\n"));

  return `Updated ${CURRENT_TODOS.length} tasks`;
}

// 自注册：加一个工具 = 加一行
TOOL_HANDLERS.set("todo_write", runTodoWrite);
