import { exec } from "node:child_process";
import { cwd } from "node:process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execAsync = promisify(exec);

const WORKDIR = process.cwd();

// ── 工具注册表契约（s02 起贯穿所有 lesson）──
export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs) => string | Promise<string>;
export const TOOL_HANDLERS = new Map<string, ToolHandler>();

// 危险命令拦截（bash 工具）
const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

// ── 路径安全：限制在 base 之内（file tools 用，base 默认 WORKDIR）──
function resolveSafe(p: string, base: string = WORKDIR): string {
  const b = path.resolve(base);
  const target = path.resolve(b, p);
  const rel = path.relative(b, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return target;
}

export function isInsideWorkspace(p: string): boolean {
  try {
    resolveSafe(p);
    return true;
  } catch {
    return false;
  }
}

// ── bash：运行 shell 命令 ──────────────────────
export async function runBash(command: string, cwdOverride?: string): Promise<string> {
  if (DANGEROUS.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwdOverride ?? cwd(),
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = `${stdout}${stderr}`.trim();
    return out ? out.slice(0, 50_000) : "(no output)";
  } catch (err: any) {
    if (err?.killed && err?.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    if (err?.stdout !== undefined || err?.stderr !== undefined) {
      const out = `${(err.stdout ?? "")}${(err.stderr ?? "")}`.trim();
      return out ? out.slice(0, 50_000) : "Error: command failed (no output)";
    }
    return `Error: ${err?.message ?? err}`;
  }
}

// ── read_file：读文件（可选行数限制）──
export function runRead(args: ToolArgs, cwdOverride?: string): string {
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  try {
    let lines = fs.readFileSync(resolveSafe(String(args.path), cwdOverride), "utf8").split(/\r?\n/);
    if (limit !== undefined && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more lines)`]);
    }
    return lines.join("\n");
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}

// ── write_file：写文件 ─────────────────────────
export function runWrite(args: ToolArgs, cwdOverride?: string): string {
  try {
    const fp = resolveSafe(String(args.path), cwdOverride);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const content = String(args.content ?? "");
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${args.path}`;
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}

// ── edit_file：精确替换一次 ────────────────────
export function runEdit(args: ToolArgs): string {
  try {
    const fp = resolveSafe(String(args.path));
    const text = fs.readFileSync(fp, "utf8");
    const oldText = String(args.old_text);
    const newText = String(args.new_text);
    if (!text.includes(oldText)) return `Error: text not found in ${args.path}`;
    fs.writeFileSync(fp, text.replace(oldText, newText));
    return `Edited ${args.path}`;
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}

// ── glob：按 pattern 查找文件 ──────────────────
function patternToRegex(pat: string): RegExp {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i++;
        if (pat[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    out.push(full);
    if (e.isDirectory()) walk(full, out);
  }
}

export function runGlob(args: ToolArgs): string {
  try {
    const pattern = String(args.pattern);
    const regex = patternToRegex(pattern);
    const all: string[] = [];
    walk(WORKDIR, all);
    const matches = all
      .map((f) => path.relative(WORKDIR, f).replace(/\\/g, "/"))
      .filter((rel) => !rel.startsWith("..") && regex.test(rel));
    return matches.length ? matches.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}

// ── 注册表：加一个工具 = 加一行 ────────────────
TOOL_HANDLERS.set("bash", (a) => runBash(String(a.command)));
TOOL_HANDLERS.set("read_file", runRead);
TOOL_HANDLERS.set("write_file", runWrite);
TOOL_HANDLERS.set("edit_file", runEdit);
TOOL_HANDLERS.set("glob", runGlob);

// ── 工具分发（s02 的核心：查表替代硬编码）──
export async function dispatchTool(name: string, args: ToolArgs): Promise<string> {
  const handler = TOOL_HANDLERS.get(name);
  if (!handler) return `Unknown tool: ${name}`;
  try {
    return await handler(args);
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}
