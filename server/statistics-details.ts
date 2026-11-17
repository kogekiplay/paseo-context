import type { ContextService } from "./service";
import type { Loaded } from "./upstream";
import { parseArgs, text } from "./value";
import type { StatsRequestDetails } from "../shared/core/stats-contract";
import { statisticsRows } from "./statistics-rows";

/** Matches the original table's per-step detail budget; no eager body cache. */
export async function statisticsDetails(data: Loaded, requestId: string, content: ContextService["content"], paseo: Parameters<ContextService["content"]>[2]): Promise<StatsRequestDetails> {
  const row = statisticsRows(data).find(({ span }) => span.id === requestId || span.requestId === requestId);
  if (!row) throw new Error("Request is no longer available");
  const { nodes, results, revision } = row;
  let remaining = 48000;
  const calls = [];
  for (const node of nodes.filter((node) => node.category === "calls").slice(0, 12)) {
    const args = await content(data.agent.id, node.id, paseo);
    const result = node.callId ? results.get(node.callId) : undefined;
    const body = result ? await content(data.agent.id, result.id, paseo) : null;
    const limit = Math.min(16000, remaining), value = body === null ? null : body.slice(0, limit);
    remaining -= value?.length ?? 0;
    const parsed = parseArgs(args);
    calls.push({ callId: node.callId ?? `node:${node.id}`, args: args.slice(0, 2000), text: value,
      chars: body?.length ?? null, lines: body === null ? null : (body.match(/\n/g)?.length ?? 0) + 1,
      truncated: body !== null && body.length > limit,
      before: text(parsed.old_string ?? parsed.oldText).slice(0, 8000) || null,
      after: text(parsed.new_string ?? parsed.newText).slice(0, 8000) || null });
  }
  let answer = "";
  let answerTruncated = false;
  for (const node of nodes.filter((node) => node.category === "assistant")) {
    if (answer.length >= 16000) { answerTruncated = true; break; }
    answer += (answer ? "\n" : "") + await content(data.agent.id, node.id, paseo);
  }
  return { requestId, contentRevision: revision, calls, answerBody: answer.slice(0, 16000) || null, answerTruncated: answerTruncated || answer.length > 16000 };
}
