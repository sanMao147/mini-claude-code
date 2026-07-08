import * as fs from "node:fs";
import * as path from "node:path";
import type OpenAI from "openai";
import { client, MODEL } from "./config.js";

// ── s09: Memory System — 跨会话持久化知识 ──────────
//   .memory/
//     MEMORY.md          ← 索引（每行一个记忆）
//     <slug>.md          ← 单个记忆文件（frontmatter + body）

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MEMORY_DIR = path.resolve(process.cwd(), ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

function ensureDir(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

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

export function writeMemoryFile(
  name: string,
  memType: string,
  description: string,
  body: string,
): string {
  ensureDir();
  const slug = name.toLowerCase().replace(/[ /]+/g, "-");
  const filename = `${slug}.md`;
  const filepath = path.join(MEMORY_DIR, filename);
  fs.writeFileSync(
    filepath,
    `---\nname: ${name}\ndescription: ${description}\ntype: ${memType}\n---\n\n${body}\n`,
  );
  rebuildIndex();
  return filepath;
}

export function rebuildIndex(): void {
  ensureDir();
  const files = fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .sort();
  const lines = files.map((f) => {
    const raw = fs.readFileSync(path.join(MEMORY_DIR, f), "utf8");
    const { meta } = parseFrontmatter(raw);
    const n = meta.name ?? f.replace(/\.md$/, "");
    const d = meta.description ?? "";
    return `- [${n}](./${f}) — ${d}`;
  });
  fs.writeFileSync(MEMORY_INDEX, lines.join("\n") + (lines.length ? "\n" : ""));
}

export function readMemoryIndex(): string {
  if (!fs.existsSync(MEMORY_INDEX)) return "";
  return fs.readFileSync(MEMORY_INDEX, "utf8").trim();
}

function readMemoryFile(filename: string): string | null {
  const p = path.join(MEMORY_DIR, filename);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

interface MemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
}

export function listMemoryFiles(): MemoryFile[] {
  if (!fs.existsSync(MEMORY_DIR)) return [];
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .sort()
    .map((f) => {
      const raw = fs.readFileSync(path.join(MEMORY_DIR, f), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      return {
        filename: f,
        name: meta.name ?? f.replace(/\.md$/, ""),
        description: meta.description ?? "",
        type: meta.type ?? "user",
        body,
      };
    });
}

function recentUserText(messages: Msg[]): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < 3; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    let c = typeof m.content === "string" ? m.content : "";
    if (Array.isArray(m.content)) {
      c = m.content
        .map((b) => (b && typeof b === "object" && "text" in b ? (b as any).text : ""))
        .join(" ");
    }
    if (c) texts.push(c);
  }
  return texts.reverse().join(" ").slice(0, 2000);
}

export async function selectRelevantMemories(messages: Msg[], maxItems = 5): Promise<string[]> {
  const files = listMemoryFiles();
  if (!files.length) return [];
  const recent = recentUserText(messages);
  if (!recent.trim()) return [];

  const catalog = files.map((f, i) => `${i}: ${f.name} — ${f.description}`).join("\n");
  const prompt =
    "Given the recent conversation and the memory catalog below, select indices of clearly " +
    "relevant memories. Return ONLY a JSON array of integers, e.g. [0,3]. If none, [].\n\n" +
    `Recent:\n${recent}\n\nCatalog:\n${catalog}`;

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const text = resp.choices[0].message.content ?? "";
    const match = text.match(/\[.*?\]/s);
    if (match) {
      const indices = JSON.parse(match[0]) as unknown[];
      const selected: string[] = [];
      for (const idx of indices) {
        const n = idx as number;
        if (Number.isInteger(n) && n >= 0 && n < files.length) {
          selected.push(files[n].filename);
          if (selected.length >= maxItems) break;
        }
      }
      return selected;
    }
  } catch {
    // fall through to keyword matching
  }

  const keywords = recent
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .map((w) => w.toLowerCase());
  const selected: string[] = [];
  for (const f of files) {
    const t = `${f.name} ${f.description}`.toLowerCase();
    if (keywords.some((kw) => t.includes(kw))) {
      selected.push(f.filename);
      if (selected.length >= maxItems) break;
    }
  }
  return selected;
}

export async function loadMemories(messages: Msg[]): Promise<string> {
  const files = await selectRelevantMemories(messages);
  if (!files.length) return "";
  const parts = ["<relevant_memories>"];
  for (const fn of files) {
    const c = readMemoryFile(fn);
    if (c) parts.push(c);
  }
  parts.push("</relevant_memories>");
  return parts.join("\n\n");
}

function dialogueText(messages: Msg[]): string {
  const parts: string[] = [];
  for (const m of messages.slice(-10)) {
    let c = typeof m.content === "string" ? m.content : "";
    if (Array.isArray(m.content)) {
      c = m.content
        .map((b) => (b && typeof b === "object" && "text" in b ? (b as any).text : ""))
        .join(" ");
    }
    if (c && c.trim()) parts.push(`${m.role}: ${c}`);
  }
  return parts.join("\n");
}

export async function extractMemories(messages: Msg[]): Promise<void> {
  const dialogue = dialogueText(messages);
  if (!dialogue.trim()) return;

  const existing = listMemoryFiles();
  const existingDesc = existing.length
    ? existing.map((m) => `- ${m.name}: ${m.description}`).join("\n")
    : "(none)";

  const prompt =
    "Extract user preferences, constraints, or project facts from this dialogue.\n" +
    "Return a JSON array. Each item: {name, type, description, body}.\n" +
    "- type: one of 'user' (user preference), 'feedback', 'project', 'reference'\n" +
    "- name: short kebab-case identifier\n" +
    "- description: one-line summary for index lookup\n" +
    "- body: full detail in markdown\n" +
    "If nothing new or already covered, return [].\n\n" +
    `Existing memories:\n${existingDesc}\n\nDialogue:\n${dialogue.slice(0, 4000)}`;

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    });
    const text = resp.choices[0].message.content ?? "";
    const match = text.match(/\[.*\]/s);
    if (!match) return;
    const items = JSON.parse(match[0]) as any[];
    let count = 0;
    for (const mem of items) {
      const name = mem.name ?? `memory-${Date.now()}`;
      const desc = mem.description ?? "";
      const body = mem.body ?? "";
      if (desc && body) {
        writeMemoryFile(name, mem.type ?? "user", desc, body);
        count++;
      }
    }
    if (count) console.log(`\n\x1b[33m[Memory: extracted ${count} new memories]\x1b[0m`);
  } catch {
    // ignore extraction failures
  }
}

const CONSOLIDATE_THRESHOLD = 10;

export async function consolidateMemories(): Promise<void> {
  const files = listMemoryFiles();
  if (files.length < CONSOLIDATE_THRESHOLD) return;

  const catalog = files
    .map((f) => `## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`)
    .join("\n\n");

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "user",
          content:
            "Consolidate the following memory files. Return a JSON array of {name,type,description,body}. " +
            "Merge duplicates, remove stale. Keep under 30. Preserve important user preferences.\n\n" +
            catalog.slice(0, 16000),
        },
      ],
      max_tokens: 3000,
    });
    const text = resp.choices[0].message.content ?? "";
    const match = text.match(/\[.*\]/s);
    if (!match) return;
    const items = JSON.parse(match[0]) as any[];
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      if (f !== "MEMORY.md" && f.endsWith(".md")) fs.unlinkSync(path.join(MEMORY_DIR, f));
    }
    for (const mem of items) {
      const name = mem.name ?? `memory-${Date.now()}`;
      const desc = mem.description ?? "";
      const body = mem.body ?? "";
      if (desc && body) writeMemoryFile(name, mem.type ?? "user", desc, body);
    }
    console.log(`\n\x1b[33m[Memory: consolidated ${files.length} → ${items.length} memories]\x1b[0m`);
  } catch {
    // ignore consolidation failures
  }
}
