import { skillCatalog } from "./skills.js";
import { readMemoryIndex } from "./memory.js";
import { TOOL_HANDLERS } from "./tools.js";
import { getConnectedMcps } from "./mcp.js";

// ── s10: 运行时按真实状态组装系统提示，带确定性缓存 ──
//   PROMPT_SECTIONS: 主题分段，每段独立维护
//   assembleSystemPrompt(ctx): 始终加载 identity/tools/workspace，按需加载 skills/memory
//   getSystemPrompt(ctx): 用 json.dumps 确定性序列化做 cache key，避免重复拼接

export const PROMPT_SECTIONS = {
  identity: "You are a coding agent. Act, don't explain.",
  tools:
    "Before starting any multi-step task, use todo_write to plan your steps.\n" +
    "For complex sub-problems, use the task tool to spawn a subagent.",
  workspace: `Working directory: ${process.cwd()}`,
  skills: "Skills available (load full content with load_skill when needed):",
  memory: "Relevant memories are injected below when available.",
};

export interface PromptContext {
  enabled_tools: string[];
  workspace: string;
  skills: string; // 技能目录文本（空串 = 不加载 skills 段）
  memories: string; // MEMORY.md 索引内容（空串 = 不加载 memory 段）
  mcp: string; // 已连接的 MCP server 名（逗号分隔，空串 = 不加载 mcp 段）
}

// 从真实状态派生 context（工具是否注册、文件是否存在，而非消息关键词）
export function updateContext(): PromptContext {
  let memories = "";
  try {
    const idx = readMemoryIndex();
    if (idx) memories = idx;
  } catch {
    /* ignore read errors */
  }
  const skills = skillCatalog();
  return {
    enabled_tools: Array.from(TOOL_HANDLERS.keys()),
    workspace: process.cwd(),
    skills,
    memories,
    mcp: getConnectedMcps().join(", "),
  };
}

// 按需拼接：始终加载三段，按真实状态决定是否加载 skills/memory/mcp
export function assembleSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];
  sections.push(PROMPT_SECTIONS.identity);
  sections.push(PROMPT_SECTIONS.tools);
  sections.push(PROMPT_SECTIONS.workspace);
  if (ctx.skills.trim()) {
    sections.push(`${PROMPT_SECTIONS.skills}\n${ctx.skills}`);
  }
  if (ctx.memories.trim()) {
    sections.push(`Relevant memories:\n${ctx.memories}`);
  }
  if (ctx.mcp.trim()) {
    sections.push(`Connected MCP servers: ${ctx.mcp}`);
  }
  return sections.join("\n\n");
}

let _lastKey: string | null = null;
let _lastPrompt: string | null = null;

// 确定性缓存：context 没变就直接返回，命中显示 [cache hit]
export function getSystemPrompt(ctx: PromptContext): string {
  const key = JSON.stringify(ctx);
  if (key === _lastKey && _lastPrompt) {
    console.log("  \x1b[90m[cache hit] system prompt unchanged\x1b[0m");
    return _lastPrompt;
  }
  _lastKey = key;
  _lastPrompt = assembleSystemPrompt(ctx);
  const loaded = ["identity", "tools", "workspace"];
  if (ctx.skills.trim()) loaded.push("skills");
  if (ctx.memories.trim()) loaded.push("memory");
  console.log(`  \x1b[32m[assembled] sections: ${loaded.join(", ")}\x1b[0m`);
  return _lastPrompt;
}
