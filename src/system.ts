import { skillCatalog } from "./skills.js";
import { readMemoryIndex } from "./memory.js";

// ── s09: 组合系统提示 ─────────────────────────────
//   技能目录（s07）+ 记忆索引（s09）注入到 SYSTEM。

export function agentSystemPrompt(): string {
  const catalog = skillCatalog();
  const memIndex = readMemoryIndex();
  const memSection = memIndex ? `\n\nMemories available:\n${memIndex}` : "";

  return [
    `You are a coding agent at ${process.cwd()}.`,
    `Before starting any multi-step task, use todo_write to plan your steps.`,
    `For complex sub-problems, use the task tool to spawn a subagent.`,
    `Skills available:`,
    catalog,
    `Use load_skill to get full details when needed.`,
    memSection,
    `When the user expresses a clear preference or says 'remember', extract it as a memory.`,
    `Act, don't explain.`,
  ].join("\n");
}
