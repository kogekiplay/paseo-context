import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { ContextService } from "../server/service";
import { SessionReader } from "../server/reader";
import { UiRoutes } from "../server/ui-routes";

// Uses generated sample records only. No local Paseo connection or user sessions.
const root = resolve(".tmp/demo"), now = Date.now(), nonce = randomUUID(), token = randomUUID();
await mkdir(`${root}/sessions`, { recursive: true });
const names = ["Atlas UI", "Accessibility review", "Accounting verification"];
const agents = names.map((title, i) => ({
  id: `demo-${i}`, title, provider: "codex", cwd: "/demo/atlas", model: "gpt-5",
  status: i === 0 ? "running" : "idle", createdAt: new Date(now - 3600000).toISOString(), updatedAt: new Date(now).toISOString(),
  labels: i ? { "paseo.parent-agent-id": "demo-0" } : {}, persistence: { nativeHandle: `sample-${i}` },
  workspaceId: "demo-workspace",
})) as unknown as PaseoAgent[];
for (let a = 0; a < agents.length; a++) {
  const rows: unknown[] = [], base = now - 3600000;
  const add = (type: string, payload: unknown, at: number) => rows.push({ type, payload, timestamp: new Date(at).toISOString() });
  const message = (role: string, text: string, at: number) => add("response_item", { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] }, at);
  add("session_meta", { base_instructions: { text: "You are working on the Atlas demo project. Explain changes and verify observable behavior. ".repeat(80) } }, base);
  let step = 0;
  for (let turn = 1; turn <= 4; turn++) {
    const start = base + turn * 600000;
    add("turn_context", { turn_id: `turn-${turn}`, model: "gpt-5", tools: [
      { name: "read_file", description: "Read a source file.", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "exec_command", description: "Execute a development command.", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    ] }, start);
    message("user", ["Build the context dashboard.", "Check the accounting and request history.", "Review accessibility and compact layout.", "Verify the final change and summarize."][turn - 1], start + 1000);
    for (let s = 0; s < 6; s++) {
      step++;
      const time = start + s * 45000 + 2000, id = `call-${step}`;
      if (step === 2 && a === 0) {
        add("response_item", { type: "function_call", call_id: id, name: "update_plan", arguments: JSON.stringify({ plan: [
          { step: "Adapt context data", status: "completed" }, { step: "Verify the original interface", status: "in_progress" },
        ] }) }, time);
        add("response_item", { type: "function_call_output", call_id: id, output: "Plan updated" }, time + 250);
      } else {
        add("response_item", { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: step % 3 ? "npm run typecheck" : "npm test", workdir: "/demo/atlas" }) }, time);
        add("response_item", { type: "function_call_output", call_id: id, output: `Process exited with code 0\n${"Sample validation output. ".repeat(100 + step * 8)}` }, time + 1200);
      }
      message("assistant", "Validated the demo change. Request identities and date scopes are consistent. ".repeat(8), time + 5000);
      add("token_usage_record", { response_id: `response-${step}`, turn_id: `turn-${turn}`,
        usage: { input_tokens: 12000 + step * 3200, cached_input_tokens: 10000 + step * 2800, output_tokens: 800, reasoning_output_tokens: 200 } }, time + 6000);
      add("event_msg", { type: "token_count", info: { model_context_window: 400000 } }, time + 6100);
    }
    if (turn === 2) add("compacted", { message: "Preserved demo summary: the dashboard is implemented and needs validation." }, start + 290000);
  }
  await writeFile(`${root}/sessions/sample-${a}.jsonl`, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const paseo = { agents: {
  list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
  ref: (id: string) => ({ refresh: async () => ({ agent: agents.find((a) => a.id === id) }),
    commands: async () => ({ commands: [] }) }),
} } as unknown as PaseoApi;
const service = new ContextService(new SessionReader({ codex: root, claude: root })), routes = new UiRoutes(service);
const frame = (await readFile(".tmp/web/index.html", "utf8")).replaceAll("%%PASEO_CONTEXT_NONCE%%", nonce);
const preferences = { defaultPlacement: "all", defaultGranularity: "step", defaultTrendMode: "total", defaultDeltaBase: "step",
  defaultToolSort: "size", defaultFileSort: "latest", insightsEntry: "show", defaultDurationCurve: "show", overviewAutoSteps: "200",
  defaultOverviewRange: "30d", fleetTab: "show", promptPrefix: "", promptSuffix: "" };
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/frame") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(frame); return; }
    if (request.url === "/rpc" && request.method === "POST") {
      if (request.headers["x-preview-token"] !== token) { response.writeHead(403); response.end(); return; }
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 1_048_576) throw new Error("Preview input too large"); }
      const input = JSON.parse(body);
      const value = await routes.handle(input.route, input.payload, paseo);
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ value })); return;
    }
    const init = { type: "paseo-context:init", nonce, agentId: "demo-0", mode: "context", locale: "zh-CN", preferences, dark: false };
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paseo Context sample preview</title><style>html,body{height:100%;margin:0}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe id="app" src="/frame" sandbox="allow-scripts allow-downloads"></iframe><script>
const init=${JSON.stringify(init)},frame=document.getElementById("app"),query=new URLSearchParams(location.search);init.mode=query.get("mode")||"context";init.dark=query.get("dark")==="1";init.locale=query.get("locale")||"zh-CN";init.agentId=query.get("agent")||"demo-0";
window.addEventListener("message",async(event)=>{const data=event.data;if(event.source!==frame.contentWindow||data?.nonce!==init.nonce)return;
if(data.type==="paseo-context:ready")frame.contentWindow.postMessage(init,"*");
if(data.type==="paseo-context:rpc"){let result;try{if(data.route==="settings.set"){init.preferences[data.payload.field]=data.payload.value;result={value:init.preferences}}else if(data.route==="clipboard.write"){await navigator.clipboard.writeText(data.payload.text);result={value:true}}else{result=await(await fetch("/rpc",{method:"POST",headers:{"Content-Type":"application/json","X-Preview-Token":${JSON.stringify(token)}},body:JSON.stringify(data)})).json()}}catch(error){result={error:String(error)}}frame.contentWindow.postMessage({type:"paseo-context:result",nonce:init.nonce,id:data.id,...result},"*")}
if(data.type==="paseo-context:fatal")console.error(data.message);
});</script></body></html>`);
  } catch (error) { response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: String(error) })); }
});
server.listen(40778, "127.0.0.1", () => console.log("Sample preview: http://127.0.0.1:40778"));
const close = () => { routes.clear(); service.clear(); server.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
