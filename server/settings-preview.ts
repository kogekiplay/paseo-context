import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { previewAgentId } from "../shared/bridge";
import type { Agent, Usage } from "../shared/contracts";
import { ContextFold } from "./fold";
import { messagesOf } from "./normalize";
import { Pricing } from "./pricing";
import { ContextService } from "./service";
import { UiRoutes } from "./ui-routes";
import { record } from "./value";
import type { ReadBodies } from "./reader";

const titles = ["Atlas UI", "Layout review", "Accounting review"];
const samplePaths = ["src/dashboard.tsx", "src/chart.tsx", "tests/dashboard.test.ts"];
const sampleTime = (now: number, daysAgo: number) => {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(0, 0, 0, 0);
  const sinceMidnight = now - new Date(now).setHours(0, 0, 0, 0);
  return date.getTime() + Math.max(180_000, Math.min(43_200_000, sinceMidnight));
};

function sampleFold(now: number, member: number) {
  const fold = new ContextFold("codex"), rows: Record<string, unknown>[] = [];
  const add = (type: string, payload: unknown, time: number) => {
    const row = { type, payload, timestamp: new Date(time).toISOString() };
    rows.push(row); fold.apply(row);
  };
  const message = (role: "user" | "assistant", text: string, time: number) => add("response_item", {
    type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  }, time);
  const tools = ["read_file", "apply_patch", "exec_command"].map((name) => ({
    name, description: `Sample ${name} tool`, parameters: { type: "object", properties: { path: { type: "string" } } },
  }));
  const turnCount = member ? 3 : 12, steps = member ? 4 : 10;
  const windows = member === 1 ? [2, 1, 0] : member === 2 ? [18, 14, 8] : [4, 3, 1, 0];
  add("session_meta", { base_instructions: { text: "Work on the Atlas demo dashboard. Explain changes and verify observable behavior. ".repeat(30) } }, sampleTime(now, windows[0] + 1));
  for (let turn = 0; turn < turnCount; turn++) {
    const day = windows[Math.floor(turn / turnCount * windows.length)];
    const start = sampleTime(now, day) - (turnCount - turn) * 15_000;
    const turnId = `sample-turn-${turn}`;
    add("turn_context", { turn_id: turnId, model: member === 0 && turn < 6 ? "gpt-5-mini" : "gpt-5", tools }, start);
    message("user", ["Build the usage dashboard.", "Review the compact layout.", "Verify chart totals and request details."][turn % 3], start + 50);
    for (let step = 0; step < steps; step++) {
      const at = start + 150 + step * 1100, id = `sample-${turn}-${step}`, path = samplePaths[(turn + step) % samplePaths.length];
      const name = step % 4 === 0 ? "read_file" : step % 4 === 1 ? "apply_patch" : "exec_command";
      const call = { call_id: id, name };
      if (name === "apply_patch") add("response_item", { ...call, type: "custom_tool_call",
        input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-export const columns = 2;\n+export const columns = 3;\n*** End Patch`,
      }, at);
      else add("response_item", { ...call, type: "function_call", arguments: JSON.stringify(name === "read_file" ? { path }
        : { cmd: step % 3 ? "npm run typecheck" : "npm test", workdir: "/demo/atlas" }) }, at);
      add("response_item", { type: "function_call_output", call_id: id, output: name === "read_file"
        ? "export const columns = 2;\nexport const compactColumns = 1;" : "Process exited with code 0\nSample checks passed." }, at + 210 + (step % 3) * 60);
      message("assistant", "Verified the dashboard layout and request totals against sample data.", at + 500);
      const input = 9000 + turn * 1300 + step * 900;
      add("token_usage_record", { response_id: id, turn_id: turnId, usage: {
        input_tokens: input, cached_input_tokens: Math.round(input * (0.68 + step % 3 * 0.07)), output_tokens: 160 + step * 25, reasoning_output_tokens: 80,
      } }, at + 620 + (step % 4) * 90);
      add("event_msg", { type: "token_count", info: { model_context_window: 400000 } }, at + 950);
    }
  }
  return { fold, rows };
}

class SamplePricing extends Pricing {
  override async refresh() {}
  override cost(_provider: string, _model: string, usage: Usage) {
    return (Math.max(0, usage.input - usage.cacheRead) * 1.25 + usage.cacheRead * 0.125 + usage.output * 10) / 1_000_000;
  }
}

class SampleReader {
  private data: Map<string, ReturnType<typeof sampleFold>>;
  constructor(agents: PaseoAgent[], now: number) {
    this.data = new Map(agents.map((agent, index) => [agent.id, sampleFold(now, index)]));
  }
  async locate() { return null; }
  async read({ id }: Agent) {
    const entry = this.data.get(id);
    if (!entry) return null;
    const bodies: ReadBodies = async (ids, project) => {
      const results = new Map<number, ReturnType<typeof project>>();
      for (const nodeId of ids) results.set(nodeId, project(nodeId, await this.content({ id }, nodeId)));
      return results;
    };
    return { entry, bodies };
  }
  async content({ id }: Pick<Agent, "id">, nodeId: number) {
    const entry = this.data.get(id), node = entry?.fold.nodes[nodeId];
    if (!entry || !node) throw new Error("Sample content is unavailable");
    return messagesOf(entry.rows[node.line - 1], "codex").find((message) => message.block === node.block)?.text ?? "";
  }
  clear() { this.data.clear(); }
}

function sampleCorpus(now: number) {
  const ids = [previewAgentId, "preview-layout", "preview-accounting"];
  const agents = ids.map((id, i) => ({ id, title: titles[i], provider: "codex", model: "gpt-5", cwd: "/demo/atlas",
    workspaceId: "preview-workspace", createdAt: new Date(sampleTime(now, [5, 3, 19][i])).toISOString(),
    updatedAt: new Date(sampleTime(now, i === 2 ? 8 : 0)).toISOString(),
    status: i === 1 ? "running" : "idle", labels: i ? { "paseo.parent-agent-id": previewAgentId } : {},
  })) as unknown as PaseoAgent[];
  const entries = agents.map((agent) => ({ agent }));
  const paseo = { agents: {
    list: async () => ({ entries, pageInfo: { hasMore: false } }),
    ref: (id: string) => ({
      refresh: async () => entries.find(({ agent }) => agent.id === id),
      commands: async () => ({ commands: [] }),
      timeline: { refetch: async () => ({ epoch: "sample", hasOlder: false, entries: id !== previewAgentId ? [] : ids.slice(1).map((child, index) => ({ item: {
        type: "tool_call", name: "spawn_agent", callId: `sample-review-${index}`,
        status: index ? "completed" : "running", detail: { type: "sub_agent", childSessionId: child, description: titles[index + 1] },
      } })) }) },
    }),
  } } as unknown as PaseoApi;
  const reader = new SampleReader(agents, now);
  const service = new ContextService(reader, new SamplePricing());
  const routes = new UiRoutes(service);
  return { paseo, routes, clear: () => { routes.clear(); service.clear(); } };
}

const sampleRoutes = new Set([
  "bootstrap", "family", "statistics.details", "history.page", "ui.grammar", "detail", "delta", "facts", "heads", "commands", "snapshot", "fleet", "overview", "skills",
]);

export class SettingsPreview {
  private sample?: ReturnType<typeof sampleCorpus>;
  private day = "";
  constructor(private now = Date.now) {}
  async handle(route: string, payload: unknown) {
    const name = route.replace(/^api\/paseo-context\//, "");
    if (name === "version" || name === "balance") return { ok: true, value: null };
    if (name === "recom") return { ok: true, value: [] };
    if (name === "file.preview") {
      const path = record(payload).path;
      const file = samplePaths.find((sample) => path === sample || path === `/demo/atlas/${sample}`);
      if (!file) throw new Error("Sample file is unavailable");
      return { src: "", name: file, text: "```ts\nexport const columns = 3;\nexport const compactColumns = 1;\n```" };
    }
    // Only the approved read routes receive the in-memory agent directory.
    // No real host SDK, local files, settings or public metadata enter here.
    if (!sampleRoutes.has(name)) throw new Error("Unavailable in settings preview");
    const now = this.now(), day = new Date(now).toDateString();
    if (!this.sample || this.day !== day) {
      this.clear(); this.sample = sampleCorpus(now); this.day = day;
    }
    // The local, non-polling preview can return a full snapshot. Numeric
    // session revisions restart when the fixture rolls over to a new day.
    const input = route === "bootstrap" ? { ...record(payload), revision: undefined, familyRevision: undefined } : payload;
    return this.sample.routes.rpc(route, input, this.sample.paseo);
  }
  clear() { this.sample?.clear(); this.sample = undefined; }
}
