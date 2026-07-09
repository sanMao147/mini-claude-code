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

// Hook 回调接收当前事件的数据；返回 null/undefined 表示继续执行。
// 返回字符串时，调用方会把它当成拦截原因或续跑提示处理。
type HookCallback = (data: any) => unknown;

// 按事件保存 hook 队列；同一事件可注册多个 hook，并按注册顺序执行。
const HOOKS: Record<HookEvent, HookCallback[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

export function registerHook(event: HookEvent, callback: HookCallback): void {
  // 这里只负责注册，真正的触发点分散在 index.ts 和 agent.ts 的生命周期中。
  HOOKS[event].push(callback);
}

// 返回第一个非 null/undefined 的回调结果（教学版：PreToolUse 用它阻止执行）
export async function triggerHooks(event: HookEvent, data: any): Promise<string | null> {
  for (const cb of HOOKS[event]) {
    const result = await cb(data);
    // 第一个有返回值的 hook 会短路后续 hook。
    // 例如 PreToolUse 可阻止工具执行，Stop 可强制 agent 继续下一轮。
    if (result !== null && result !== undefined) return String(result);
  }
  return null;
}

// ── s03 的权限逻辑，现在作为 PreToolUse 钩子 ──────
// 命中这些片段直接拒绝，不再询问用户。
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];
// 命中这些片段时认为有风险，需要用户确认后才放行。
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
      // 写文件默认限制在工作区内，越界写入需要显式确认。
      console.log(`\n\x1b[33m⚠  Writing outside workspace\x1b[0m`);
      console.log(`   Tool: ${call.name}(${JSON.stringify(call.args)})`);
      if (!(await askYesNo("   Allow?"))) return "Permission denied by user";
    }
  }
  return null;
}

function logHook(call: ToolCallInfo): null {
  // 只展示参数预览，避免长参数或敏感内容完整刷屏。
  const preview = Object.values(call.args).slice(0, 2).map(String).join(", ").slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${call.name}(${preview})\x1b[0m`);
  return null;
}

function largeOutputHook(info: PostToolInfo): null {
  // 大输出可能快速消耗上下文窗口；这里先提醒，后续可扩展为自动摘要。
  if (info.output.length > 100000) {
    console.log(`\x1b[33m[HOOK] ⚠ Large output from ${info.name}: ${info.output.length} chars\x1b[0m`);
  }
  return null;
}

function contextInjectHook(query: string): null {
  // 当前版本只打印上下文信息；如果要真正注入提示词，需要让调用方修改 messages。
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${process.cwd()}\x1b[0m`);
  return null;
}

function summaryHook(messages: unknown): null {
  // Stop 阶段可以访问完整消息历史，这里用它统计工具调用次数。
  const msgs = messages as Array<{ role?: string }>;
  const count = msgs.filter((m) => m.role === "tool").length;
  console.log(`\x1b[90m[HOOK] Stop: session used ${count} tool calls\x1b[0m`);
  return null;
}

// 默认注册的教学版 hook：输入提示、权限控制、工具日志、大输出提醒、结束摘要。
registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);
