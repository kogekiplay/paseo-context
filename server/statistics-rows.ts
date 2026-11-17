import { createHash } from "node:crypto";
import type { Loaded } from "./upstream";

/** Shared ownership and revision for summaries and lazy details. */
export function statisticsRows(data: Loaded) {
  const requests = new Map(data.requests.map((request) => [request.id, request]));
  const results = new Map(data.fold.nodes.filter((node) => (node.category === "tool" || node.category === "skill") && node.callId)
    .map((node) => [node.callId!, node]));
  return data.fold.statistics.rows.map((span) => {
    const request = span.requestId ? requests.get(span.requestId) : undefined;
    const nodes = span.nodeIds.map((id) => data.fold.nodes[id]);
    const fingerprint = [data.fold.epoch, span.closed, span.end, span.interrupted, span.aborted, request,
      ...nodes.map((node) => [node.id, node.line, data.fold.contentHashes[node.id],
        node.callId ? data.fold.contentHashes[results.get(node.callId)?.id ?? -1] : null])];
    const revision = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 24);
    return { span, request, nodes, results, revision };
  });
}
