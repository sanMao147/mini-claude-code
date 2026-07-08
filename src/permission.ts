import { askYesNo } from "./input.js";
import { isInsideWorkspace, type ToolArgs } from "./tools.js";

// ── s03: 三道闸门权限管线 ───────────────────────
//   Gate 1: 硬拒绝列表（永远禁止）
//   Gate 2: 规则匹配（依赖上下文，需用户确认）
//   Gate 3: 用户审批（规则命中后暂停等待）

// Gate 1: 硬拒绝列表
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) return `Blocked: '${pattern}' is on the deny list`;
  }
  return null;
}

// Gate 2: 规则匹配
type PermissionRule = {
  tools: string[];
  check: (args: ToolArgs) => boolean;
  message: string;
};

const PERMISSION_RULES: PermissionRule[] = [
  {
    tools: ["write_file", "edit_file"],
    check: (args) => !isInsideWorkspace(String(args.path ?? "")),
    message: "Writing outside workspace",
  },
  {
    tools: ["bash"],
    check: (args) => ["rm ", "> /etc/", "chmod 777"].some((kw) => String(args.command ?? "").includes(kw)),
    message: "Potentially destructive command",
  },
];

function checkRules(toolName: string, args: ToolArgs): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(toolName) && rule.check(args)) return rule.message;
  }
  return null;
}

// Gate 3: 用户审批（在工具执行之前）
async function askUser(toolName: string, args: ToolArgs, reason: string): Promise<"allow" | "deny"> {
  console.log(`\n\x1b[33m⚠  ${reason}\x1b[0m`);
  console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
  const ok = await askYesNo("   Allow?");
  return ok ? "allow" : "deny";
}

// 三道闸门串联，插在工具执行之前
export async function checkPermission(toolName: string, args: ToolArgs): Promise<boolean> {
  // 闸门 1: 硬拒绝
  if (toolName === "bash") {
    const reason = checkDenyList(String(args.command ?? ""));
    if (reason) {
      console.log(`\n\x1b[31m⛔ ${reason}\x1b[0m`);
      return false;
    }
  }

  // 闸门 2 + 闸门 3: 规则命中 → 用户审批
  const reason = checkRules(toolName, args);
  if (reason) {
    const decision = await askUser(toolName, args, reason);
    if (decision === "deny") return false;
  }

  return true;
}
