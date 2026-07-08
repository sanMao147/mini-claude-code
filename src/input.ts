import * as readline from "node:readline";

// ── 共享输入：REPL 与权限询问共用同一个 readline 接口，避免多接口抢占 stdin ──
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

export function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export function askYesNo(question: string): Promise<boolean> {
  return ask(`${question} [y/N] `).then((a) => ["y", "yes"].includes(a.trim().toLowerCase()));
}

export function closeInput(): void {
  rl.close();
}
