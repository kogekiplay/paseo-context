import { createHash } from "node:crypto";
import type { Loaded } from "./upstream";
import type { StatisticsSpan } from "./statistics-spans";

/** Shared ownership and revision for summaries and lazy details. */
function rowOf(data: Loaded, span: StatisticsSpan) {
  const results = data.fold.toolResults;
  const index = span.requestId ? data.fold.requestIndex(span.requestId) : undefined;
  const request = index === undefined ? undefined : data.requests[index];
  const nodes = span.nodeIds.map((id) => data.fold.nodes[id]);
  const fingerprint = [data.fold.epoch, span.closed, span.end, span.interrupted, span.aborted,
    ...nodes.map((node) => [node.id, node.line, data.fold.contentHashes[node.id],
      node.callId ? data.fold.contentHashes[results.get(node.callId)?.id ?? -1] : null])];
  const revision = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 24);
  return { span, request, nodes, results, revision };
}

export function statisticsRows(data: Loaded) { return data.fold.statistics.rows.map((span) => rowOf(data, span)); }

export function statisticsRow(data: Loaded, id: string) {
  const span = data.fold.statistics.find(id);
  return span && rowOf(data, span);
}
