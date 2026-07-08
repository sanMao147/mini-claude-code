import type OpenAI from "openai";
import { TOOL_HANDLERS, type ToolArgs } from "./tools.js";
import { TOOLS } from "./config.js";

// ── s19: MCP Plugin — MCPClient + 工具发现 + assembleToolPool ──
//   教学版用内存 mock server（docs/deploy）演示 MCP 的"连接→发现→调用"；
//   工具以 mcp__{server}__{tool} 前缀并入统一工具池，零额外依赖。

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type MCPHandler = (args: ToolArgs) => string;

export class MCPClient {
  tools: MCPToolDef[] = [];
  private handlers = new Map<string, MCPHandler>();
  constructor(public name: string) {}

  register(toolDefs: MCPToolDef[], handlers: Record<string, MCPHandler>): void {
    this.tools = toolDefs;
    for (const [k, v] of Object.entries(handlers)) this.handlers.set(k, v);
  }

  callTool(toolName: string, args: ToolArgs): string {
    const h = this.handlers.get(toolName);
    if (!h) return `MCP error: unknown tool '${toolName}'`;
    try {
      return h(args);
    } catch (e: any) {
      return `MCP error: ${e?.message ?? e}`;
    }
  }
}

const mcpClients = new Map<string, MCPClient>();

const DISALLOWED = /[^a-zA-Z0-9_-]/g;

// 规范化 server/tool 名字：非 [a-zA-Z0-9_-] 替换为下划线
export function normalizeMcpName(name: string): string {
  return name.replace(DISALLOWED, "_");
}

// ── Mock servers（教学用，实际接入时用 stdio JSON-RPC）──
function mockDocsServer(): MCPClient {
  const c = new MCPClient("docs");
  c.register(
    [
      { name: "search", description: "Search documentation. (readOnly)",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "get_version", description: "Get API version. (readOnly)",
        inputSchema: { type: "object", properties: {}, required: [] } },
    ],
    {
      search: (a) => `[docs] Found 3 results for '${String(a.query ?? "")}'`,
      get_version: () => "[docs] API v2.1.0",
    },
  );
  return c;
}

function mockDeployServer(): MCPClient {
  const c = new MCPClient("deploy");
  c.register(
    [
      { name: "trigger", description: "Trigger a deployment. (destructive)",
        inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] } },
      { name: "status", description: "Check deployment status. (readOnly)",
        inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] } },
    ],
    {
      trigger: (a) => `[deploy] Triggered: ${String(a.service ?? "")}`,
      status: (a) => `[deploy] ${String(a.service ?? "")}: running (v1.4.2)`,
    },
  );
  return c;
}

const MOCK_SERVERS: Record<string, () => MCPClient> = {
  docs: mockDocsServer,
  deploy: mockDeployServer,
};

export function connectMcp(name: string): string {
  if (mcpClients.has(name)) return `MCP server '${name}' already connected`;
  const factory = MOCK_SERVERS[name];
  if (!factory) {
    return `Unknown server '${name}'. Available: ${Object.keys(MOCK_SERVERS).join(", ")}`;
  }
  const client = factory();
  mcpClients.set(name, client);
  // 把每个 MCP 工具以 mcp__{server}__{tool} 前缀注册进 TOOL_HANDLERS
  const safeServer = normalizeMcpName(name);
  for (const t of client.tools) {
    const prefixed = `mcp__${safeServer}__${normalizeMcpName(t.name)}`;
    TOOL_HANDLERS.set(prefixed, (a) => client.callTool(t.name, a));
  }
  const toolNames = client.tools.map((t) => t.name);
  console.log(`  \x1b[31m[mcp] connected: ${name} → ${toolNames.join(", ")}\x1b[0m`);
  return `Connected to MCP server '${name}'. Discovered ${client.tools.length} tools: ${toolNames.join(", ")}`;
}

export function getConnectedMcps(): string[] {
  return [...mcpClients.keys()];
}

// 组装统一工具池：内置工具 + 所有已连接 MCP 工具的（前缀）定义
export function assembleToolPool(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const out: OpenAI.Chat.Completions.ChatCompletionTool[] = [...TOOLS];
  for (const [serverName, client] of mcpClients) {
    const safeServer = normalizeMcpName(serverName);
    for (const t of client.tools) {
      out.push({
        type: "function",
        function: {
          name: `mcp__${safeServer}__${normalizeMcpName(t.name)}`,
          description: t.description,
          parameters: t.inputSchema as any,
        },
      });
    }
  }
  return out;
}

// ── 自注册 Lead MCP 工具 ──
TOOL_HANDLERS.set("connect_mcp", (a) => connectMcp(String(a.name)));
