import { exec } from "node:child_process";
import { cwd } from "node:process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

// ── 工具执行：运行 shell 命令 ────────────────────
export async function runBash(command: string): Promise<string> {
  if (DANGEROUS.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd(),
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = `${stdout}${stderr}`.trim();
    return out ? out.slice(0, 50_000) : "(no output)";
  } catch (err: any) {
    // 超时：exec 会杀掉进程并设置 killed/signal
    if (err?.killed && err?.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    // 命令执行失败但可能有部分输出
    if (err?.stdout !== undefined || err?.stderr !== undefined) {
      const out = `${(err.stdout ?? "")}${(err.stderr ?? "")}`.trim();
      return out ? out.slice(0, 50_000) : "Error: command failed (no output)";
    }
    return `Error: ${err?.message ?? err}`;
  }
}
