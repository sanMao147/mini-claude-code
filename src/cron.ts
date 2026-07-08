import * as fs from "node:fs";
import * as path from "node:path";
import { TOOL_HANDLERS, type ToolArgs } from "./tools.js";

// ── s14: Cron Scheduler — 独立轮询 + 队列解耦 agent loop ──
//   四层：调度器(每 1s 轮询) → 队列(cronQueue) → 队列处理器(空闲时唤醒) → agent 消费注入

export interface CronJob {
  id: string;
  cron: string; // 5 字段: 分 时 日 月 周
  prompt: string; // 触发时注入的消息
  recurring: boolean; // True=循环, False=一次性
  durable: boolean; // True=持久化到磁盘
}

const DURABLE_PATH = path.resolve(process.cwd(), ".scheduled_tasks.json");

const scheduledJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const lastFired = new Map<string, string>(); // job_id → "YYYY-MM-DD HH:MM"
let cronCounter = 0;

// �─ 单字段匹配 ─
function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  if (field.includes(",")) {
    return field.split(",").some((f) => cronFieldMatches(f.trim(), value));
  }
  if (field.includes("-")) {
    const [lo, hi] = field.split("-");
    return parseInt(lo, 10) <= value && value <= parseInt(hi, 10);
  }
  return value === parseInt(field, 10);
}

// ── 5 字段匹配（DOM/DOW 均为受限时用 OR 语义）──
export function cronMatches(cronExpr: string, dt: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  const dowVal = dt.getDay(); // JS getDay(): 日=0 → 与 cron DOW 一致
  const m = cronFieldMatches(minute, dt.getMinutes());
  const h = cronFieldMatches(hour, dt.getHours());
  const domOk = cronFieldMatches(dom, dt.getDate());
  const monthOk = cronFieldMatches(month, dt.getMonth() + 1);
  const dowOk = cronFieldMatches(dow, dowVal);
  if (!(m && h && monthOk)) return false;
  const domUn = dom === "*";
  const dowUn = dow === "*";
  if (domUn && dowUn) return true;
  if (domUn) return dowOk;
  if (dowUn) return domOk;
  return domOk || dowOk;
}

function validateCronField(field: string, lo: number, hi: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const s = field.slice(2);
    if (!/^\d+$/.test(s)) return `Invalid step: ${field}`;
    if (parseInt(s, 10) <= 0) return `Step must be > 0: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const err = validateCronField(part.trim(), lo, hi);
      if (err) return err;
    }
    return null;
  }
  if (field.includes("-")) {
    const parts = field.split("-");
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return `Invalid range: ${field}`;
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (a < lo || a > hi || b < lo || b > hi) return `Range ${field} out of bounds [${lo}-${hi}]`;
    if (a > b) return `Range start > end: ${field}`;
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const v = parseInt(field, 10);
  if (v < lo || v > hi) return `Value ${v} out of bounds [${lo}-${hi}]`;
  return null;
}

export function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const bounds: [number, number][] = [
    [0, 59], [0, 23], [1, 31], [1, 12], [0, 6],
  ];
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < fields.length; i++) {
    const err = validateCronField(fields[i], bounds[i][0], bounds[i][1]);
    if (err) return `${names[i]}: ${err}`;
  }
  return null;
}

function saveDurableJobs(): void {
  const durable = Array.from(scheduledJobs.values()).filter((j) => j.durable);
  fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2));
}

export function loadDurableJobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) return;
  try {
    const jobs = JSON.parse(fs.readFileSync(DURABLE_PATH, "utf8")) as CronJob[];
    for (const j of jobs) {
      if (validateCron(j.cron)) {
        console.log(`  \x1b[31m[cron] skipping invalid job ${j.id}\x1b[0m`);
        continue;
      }
      scheduledJobs.set(j.id, j);
    }
    if (scheduledJobs.size) {
      console.log(`  \x1b[35m[cron] loaded ${scheduledJobs.size} durable job(s)\x1b[0m`);
    }
  } catch {
    /* ignore corrupt file */
  }
}

export function scheduleJob(
  cron: string,
  prompt: string,
  recurring = true,
  durable = true,
): CronJob | string {
  const err = validateCron(cron);
  if (err) return err;
  cronCounter += 1;
  const job: CronJob = {
    id: `cron_${cronCounter.toString().padStart(6, "0")}`,
    cron, prompt, recurring, durable,
  };
  scheduledJobs.set(job.id, job);
  if (durable) saveDurableJobs();
  return job;
}

export function cancelJob(jobId: string): string {
  const job = scheduledJobs.get(jobId);
  if (!job) return `Job ${jobId} not found`;
  scheduledJobs.delete(jobId);
  if (job.durable) saveDurableJobs();
  return `Cancelled ${jobId}`;
}

export function listCrons(): string {
  if (scheduledJobs.size === 0) return "No cron jobs. Use schedule_cron to add one.";
  const lines: string[] = [];
  for (const j of scheduledJobs.values()) {
    const tag = j.recurring ? "recurring" : "one-shot";
    const dur = j.durable ? "durable" : "session";
    lines.push(`  ${j.id}: '${j.cron}' → ${j.prompt.slice(0, 40)} [${tag}, ${dur}]`);
  }
  return lines.join("\n");
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

// ── 调度器：每 1s 轮询，命中的 job 进队列 ──
function tick(): void {
  const now = new Date();
  const marker = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  for (const job of Array.from(scheduledJobs.values())) {
    try {
      if (cronMatches(job.cron, now)) {
        if (lastFired.get(job.id) !== marker) {
          cronQueue.push(job);
          lastFired.set(job.id, marker);
          console.log(`  \x1b[35m[cron fire] ${job.id} → ${job.prompt.slice(0, 40)}\x1b[0m`);
        }
        if (!job.recurring) {
          scheduledJobs.delete(job.id);
          if (job.durable) saveDurableJobs();
        }
      }
    } catch (e: any) {
      console.log(`  \x1b[31m[cron error] ${job.id}: ${e?.message ?? e}\x1b[0m`);
    }
  }
}

export function startScheduler(): void {
  loadDurableJobs();
  setInterval(tick, 1000);
  console.log("  \x1b[35m[cron] scheduler started\x1b[0m");
}

// ── 队列：供 agent 消费 ──
export function consumeCronQueue(): CronJob[] {
  const fired = cronQueue.slice();
  cronQueue.length = 0;
  return fired;
}

export function hasCronQueue(): boolean {
  return cronQueue.length > 0;
}

// ── 工具 handler ──
function runScheduleCron(args: ToolArgs): string {
  const result = scheduleJob(
    String(args.cron ?? ""),
    String(args.prompt ?? ""),
    args.recurring !== false,
    args.durable !== false,
  );
  if (typeof result === "string") return `Error: ${result}`;
  return `Scheduled ${result.id}: '${result.cron}' → ${result.prompt}`;
}

function runListCrons(_args: ToolArgs): string {
  return listCrons();
}

function runCancelCron(args: ToolArgs): string {
  return cancelJob(String(args.job_id ?? ""));
}

// 自注册 3 个 cron 工具
TOOL_HANDLERS.set("schedule_cron", runScheduleCron);
TOOL_HANDLERS.set("list_crons", runListCrons);
TOOL_HANDLERS.set("cancel_cron", runCancelCron);
