import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_HANDLERS, type ToolArgs } from "./tools.js";
import { loadTask, saveTask } from "./tasks.js";

// ── s18: Worktree Isolation — git worktree + 任务绑定 + 事件日志 ──
//   每个 worktree 拥有独立分支 wt/<name>，可绑定到一个任务；
//   子 Agent 在绑定的 worktree 目录内工作，互不干扰。

const WORKDIR = process.cwd();
const WORKTREES_DIR = path.resolve(WORKDIR, ".worktrees");
const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// 拒绝路径穿越与非法字符
function validateWorktreeName(name: string): string | null {
  if (!name) return "Worktree name cannot be empty";
  if (name === "." || name === "..") return `'${name}' is not a valid worktree name`;
  if (!VALID_WT_NAME.test(name)) {
    return `Invalid worktree name '${name}': only letters, digits, dots, underscores, dashes (1-64 chars)`;
  }
  return null;
}

// 运行 git，返回 [ok, output]
function runGit(args: string[]): [boolean, string] {
  const r = spawnSync("git", args, { cwd: WORKDIR, encoding: "utf8", timeout: 30_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 5000) || "(no output)";
  return [r.status === 0, out];
}

// 追加生命周期事件到 events.jsonl
function logEvent(eventType: string, worktreeName: string, taskId = ""): void {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const event = { type: eventType, worktree: worktreeName, task_id: taskId, ts: Date.now() };
  fs.appendFileSync(path.join(WORKTREES_DIR, "events.jsonl"), JSON.stringify(event) + "\n");
}

// 读取某任务的 worktree 路径（绑定了才返回，否则 null）
export function getTaskWorktreePath(taskId: string): string | null {
  try {
    const t = loadTask(taskId);
    if (!t.worktree) return null;
    return path.join(WORKTREES_DIR, t.worktree);
  } catch {
    return null;
  }
}

// 仅写入任务的 worktree 字段，保持 pending 状态以便 auto-claim
function bindTaskToWorktree(taskId: string, worktreeName: string): void {
  const t = loadTask(taskId);
  t.worktree = worktreeName;
  saveTask(t);
  console.log(`  \x1b[33m[bind] ${t.subject} → worktree:${worktreeName}\x1b[0m`);
}

export function createWorktree(name: string, taskId = ""): string {
  const err = validateWorktreeName(name);
  if (err) return `Error: ${err}`;
  const p = path.join(WORKTREES_DIR, name);
  if (fs.existsSync(p)) return `Worktree '${name}' already exists at ${p}`;
  const [ok, result] = runGit(["worktree", "add", p, "-b", `wt/${name}`, "HEAD"]);
  if (!ok) return `Git error: ${result}`;
  if (taskId) bindTaskToWorktree(taskId, name);
  logEvent("create", name, taskId);
  console.log(`  \x1b[33m[worktree] created: ${name} at ${p}\x1b[0m`);
  return `Worktree '${name}' created at ${p}`;
}

// 统计 worktree 内的未提交文件与未推送提交数
function countWorktreeChanges(p: string): [number, number] {
  try {
    const r1 = spawnSync("git", ["status", "--porcelain"], { cwd: p, encoding: "utf8", timeout: 10_000 });
    const files = r1.stdout.trim().split(/\r?\n/).filter(Boolean).length;
    const r2 = spawnSync("git", ["log", "@{push}..HEAD", "--oneline"], { cwd: p, encoding: "utf8", timeout: 10_000 });
    const commits = r2.stdout.trim().split(/\r?\n/).filter(Boolean).length;
    return [files, commits];
  } catch {
    return [-1, -1];
  }
}

export function removeWorktree(name: string, discardChanges = false): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  const p = path.join(WORKTREES_DIR, name);
  if (!fs.existsSync(p)) return `Worktree '${name}' not found`;
  if (!discardChanges) {
    const [files, commits] = countWorktreeChanges(p);
    if (files < 0) {
      return `Cannot verify worktree '${name}' status. Use discard_changes=true to force removal.`;
    }
    if (files > 0 || commits > 0) {
      return (
        `Worktree '${name}' has ${files} uncommitted file(s) and ${commits} unpushed commit(s). ` +
        `Use discard_changes=true to force removal, or keep_worktree to preserve for review.`
      );
    }
  }
  const [ok] = runGit(["worktree", "remove", p, "--force"]);
  if (!ok) return `Failed to remove worktree directory for '${name}'`;
  runGit(["branch", "-D", `wt/${name}`]);
  logEvent("remove", name);
  console.log(`  \x1b[33m[worktree] removed: ${name}\x1b[0m`);
  return `Worktree '${name}' removed`;
}

export function keepWorktree(name: string): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  logEvent("keep", name);
  console.log(`  \x1b[36m[worktree] kept: ${name}\x1b[0m`);
  return `Worktree '${name}' kept for review (branch: wt/${name})`;
}

// ── 自注册 Lead worktree 工具 ──
TOOL_HANDLERS.set("create_worktree", (a) =>
  createWorktree(String(a.name), String(a.task_id ?? "")),
);
TOOL_HANDLERS.set("remove_worktree", (a) =>
  removeWorktree(String(a.name), a.discard_changes === true),
);
TOOL_HANDLERS.set("keep_worktree", (a) => keepWorktree(String(a.name)));
