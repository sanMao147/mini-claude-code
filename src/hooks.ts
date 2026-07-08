import { askYesNo } from "./input.js";
import { isInsideWorkspace, type ToolArgs } from "./tools.js";

// ── s04: Hook System ────────────────────────────
//   四个事件覆盖一个完整的 agent cycle：
//     UserPromptSubmit  用户输入提交后、进入 LLM 前
//     PreToolUse        工具执行前（权限等；返回值≠null 阻止执行）
//     PostToolUse       工具执行后（日志/副作用）
//     Stop              循环即将退出时（返回值≠null 强制续跑）

export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
export type ToolCallInfo = { name: string; args: ToolArgs };
export type PostToolInfo = { name: string; output: string };

type HookCallback = (data: any) => unknown;

const HOOKS: Record<HookEvent, HookCallback[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

export function registerHook(event: HookEvent, callback: HookCallback): void {
  HOOKS[event].push(callback);
}

// 返回第一个非 null/undefined 的回调结果（教学版：PreToolUse 用它阻止执行）
export async function triggerHooks(event: HookEvent, data: any): Promise<string | null> {
  for (const cb of HOOKS[event]) {
    const result = await cb(data);
    if (result !== null && result !== undefined) return String(result);
  }
  return null;
}

// ── s03 的权限逻辑，现在作为 PreToolUse 钩子 ──────
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

async function permissionHook(call: ToolCallInfo): Promise<string | null> {
  if (call.name === "bash") {
    const cmd = String(call.args.command ?? "");
    for (const p of DENY_LIST) {
      if (cmd.includes(p)) {
        console.log(`\n\x1b[31m⛔ Blocked: '${p}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    for (const kw of DESTRUCTIVE) {
      if (cmd.includes(kw)) {
        console.log(`\n\x1b[33m⚠  Potentially destructive command\x1b[0m`);
        console.log(`   Tool: ${call.name}(${JSON.stringify(call.args)})`);
        if (!(await askYesNo("   Allow?"))) return "Permission denied by user";
      }
    }
  }
  if (call.name === "write_file" || call.name === "edit_file") {
    const p = String(call.args.path ?? "");
    if (!isInsideWorkspace(p)) {
      console.log(`\n\x1b[33m⚠  Writing outside workspace\x1b[0m`);
      console.log(`   Tool: ${call.name}(${JSON.stringify(call.args)})`);
      if (!(await askYesNo("   Allow?"))) return "Permission denied by user";
    }
  }
  return null;
}

function logHook(call: ToolCallInfo): null {
  const preview = Object.values(call.args).slice(0, 2).map(String).join(", ").slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${call.name}(${preview})\x1b[0m`);
  return null;
}

function largeOutputHook(info: PostToolInfo): null {
  if (info.output.length > 100000) {
    console.log(`\x1b[33m[HOOK] ⚠ Large output from ${info.name}: ${info.output.length} chars\x1b[0m`);
  }
  return null;
}

function contextInjectHook(query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${process.cwd()}\x1b[0m`);
  return null;
}

function summaryHook(messages: unknown): null {
  const msgs = messages as Array<{ role?: string }>;
  const count = msgs.filter((m) => m.role === "tool").length;
  console.log(`\x1b[90m[HOOK] Stop: session used ${count} tool calls\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);
