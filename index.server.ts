import type { PluginServerContext } from "@getpaseo/plugin/server";
import { activityRpc, browserRpc, collaborationRpc, contentRpc, fleetRpc, overviewRpc, preferences, preferenceSchema, preferencesRpc, snapshotRpc } from "./shared/contracts";
import { ContextService } from "./server/service";
import { UiRoutes } from "./server/ui-routes";
import { bridgeRpc, settingsPreviewRpc } from "./shared/bridge";
import { SettingsPreview } from "./server/settings-preview";
import { Pricing } from "./server/pricing";
import { PublicCache } from "./server/public-cache";

export default function contribute(server: PluginServerContext) {
  const cache = new PublicCache();
  const service = new ContextService(undefined, new Pricing(cache));
  const ui = new UiRoutes(service, cache);
  const preview = new SettingsPreview();
  server.handle(bridgeRpc, ({ route, payload }, { paseo }) => ui.rpc(route, payload, paseo));
  server.handle(settingsPreviewRpc, ({ route, payload }) => preview.handle(route, payload));
  const settings = server.registerSettings(preferences);
  server.handle(preferencesRpc, async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : preferenceSchema.parse({});
  });
  server.handle(snapshotRpc, ({ agentId }, { paseo }) => service.snapshot(agentId, paseo));
  server.handle(browserRpc, async ({ agentId, requestId, category, query, sort, offset, limit }, { paseo }) => {
    const { fold, requests, revision } = await service.load(await service.agent(agentId, paseo), paseo);
    const request = requestId ? requests.find((r) => r.id === requestId) : null;
    if (requestId && !request) throw new Error("Request is no longer available");
    const boundary = request?.boundary ?? Infinity;
    const items = fold.nodes.filter((n) => n.id < boundary && (n.gone === undefined || n.gone >= boundary)
      && (!category || n.category === category) && `${n.title} ${n.preview} ${n.tool ?? ""} ${n.source ?? ""}`.toLowerCase().includes(query.toLowerCase()));
    items.sort((a, b) => sort === "size" ? b.tokens - a.tokens : sort === "name" ? a.title.localeCompare(b.title) : a.id - b.id);
    return { items: items.slice(offset, offset + limit), total: items.length, revision };
  });
  server.handle(contentRpc, async ({ agentId, nodeId, offset, revision }, { paseo }) => {
    const text = await service.content(agentId, nodeId, paseo, revision), end = Math.min(text.length, offset + 24000);
    return { text: text.slice(offset, end), totalChars: text.length, nextOffset: end < text.length ? end : null };
  });
  server.handle(activityRpc, async ({ agentId, kind, query, filter, sort, offset, limit }, { paseo }) => {
    const { fold } = await service.load(await service.agent(agentId, paseo), paseo), q = query.toLowerCase();
    const files = fold.files.filter((f) => (filter === "all" || f.kind === filter) && f.path.toLowerCase().includes(q));
    const commands = fold.commands.filter((c) => (filter === "all" || c.status === filter) && c.command.toLowerCase().includes(q));
    const counts = new Map<string, number>();
    for (const f of files) counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
    files.sort((a, b) => sort === "count" ? (counts.get(b.path) ?? 0) - (counts.get(a.path) ?? 0) : sort === "lines" ? (b.added + b.removed) - (a.added + a.removed) : sort === "path" || sort === "name" ? a.path.localeCompare(b.path) : b.time - a.time);
    commands.sort((a, b) => b.time - a.time);
    return { files: kind === "files" ? files.slice(offset, offset + limit) : [],
      commands: kind === "commands" ? commands.slice(offset, offset + limit) : [], total: kind === "files" ? files.length : commands.length };
  });
  server.handle(overviewRpc, ({ offset, ...scope }, { paseo }) => service.overview(scope, offset, paseo));
  server.handle(fleetRpc, async ({ agentId }, { paseo }) => {
    const { rootId, members, failed } = await service.fleet(agentId, paseo);
    return { rootId, members, failed };
  });
  server.handle(collaborationRpc, ({ agentId }, { paseo }) => service.collaboration(agentId, paseo));
  return async () => { preview.clear(); ui.clear(); service.clear(); await cache.clear(); };
}
