import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_HANDLERS, type ToolArgs } from "./tools.js";

// ── s07: Skill Loading — 两级按需知识注入 ──────────
//   Layer 1（廉价，常驻）：SYSTEM 里只放技能名 + 一行描述
//   Layer 2（昂贵，按需）：调用 load_skill(name) 注入完整 SKILL.md 内容

const SKILLS_DIR = path.resolve(process.cwd(), "skills");

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export const SKILL_REGISTRY = new Map<string, Skill>();

// 极简 frontmatter 解析（name / description），避免引入 yaml 依赖
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const parts = text.split("---");
  if (parts.length < 3) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of parts[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k && v) meta[k] = v;
    }
  }
  return { meta, body: parts[2].trim() };
}

export function scanSkills(): void {
  SKILL_REGISTRY.clear();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(SKILLS_DIR);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const dir = path.join(SKILLS_DIR, name);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const manifest = path.join(dir, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const skillName = meta.name ?? name;
    const description = meta.description ?? raw.split("\n")[0].replace(/^#\s*/, "").trim();
    SKILL_REGISTRY.set(skillName, { name: skillName, description, content: raw });
  }
}

export function listSkills(): string {
  if (SKILL_REGISTRY.size === 0) return "(no skills found)";
  const lines: string[] = [];
  for (const s of SKILL_REGISTRY.values()) lines.push(`- **${s.name}**: ${s.description}`);
  return lines.join("\n");
}

export function buildSystem(): string {
  const catalog = listSkills();
  return [
    `You are a coding agent at ${process.cwd()}.`,
    `Before starting any multi-step task, use todo_write to plan your steps.`,
    `For complex sub-problems, use the task tool to spawn a subagent.`,
    `Skills available:`,
    catalog,
    `Use load_skill to get full details when needed.`,
    `Act, don't explain.`,
  ].join("\n");
}

export function runLoadSkill(args: ToolArgs): string {
  const name = String(args.name ?? "");
  const skill = SKILL_REGISTRY.get(name);
  if (!skill) return `Skill not found: ${name}`;
  return skill.content;
}

// 启动时扫描；自注册 load_skill 工具
scanSkills();
TOOL_HANDLERS.set("load_skill", runLoadSkill);
