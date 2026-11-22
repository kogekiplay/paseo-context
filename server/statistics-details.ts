import type { ContextService } from "./service";
import type { Loaded } from "./upstream";
import { parseArgs, text } from "./value";
import type { StatsRequestDetails } from "../shared/core/stats-contract";
import { statisticsRow } from "./statistics-rows";
import { CALL_LIMIT } from "../shared/core/stats-tools";
import { antigravityArgs } from "./antigravity-log";

const PREVIEW_LIMIT = 16000;

function lineCount(body: string) {
  let lines = 1;
  for (let index = body.indexOf("\n"); index !== -1; index = body.indexOf("\n", index + 1)) lines++;
  return lines;
}

/** Matches the original table's per-step detail budget; no eager body cache. */
export async function statisticsDetails(data: Loaded, requestId: string, content: ContextService["content"], paseo: Parameters<ContextService["content"]>[2]): Promise<StatsRequestDetails> {
  const row = statisticsRow(data, requestId);
  if (!row) throw new Error("Request is no longer available");
  const { nodes, results, revision } = row;
  const selected = nodes.filter((node) => node.category === "calls").slice(0, CALL_LIMIT);
  if (data.summary.notices.includes("native-metadata-only")) {
    return { requestId, contentRevision: revision, answerBody: null, answerTruncated: false,
      calls: selected.map((node) => ({ callId: node.callId ?? `node:${node.id}`, args: null, text: null,
        chars: null, lines: null, truncated: false, before: null, after: null })) };
  }
  const argsIds = new Set(selected.map((node) => node.id));
  const answerNodes = nodes.filter((node) => node.category === "assistant");
  const answerIds: number[] = [];
  let chars = 0;
  for (const node of answerNodes) {
    if (chars >= PREVIEW_LIMIT) break;
    chars += (node.textLength ?? 0) + (answerIds.length ? 1 : 0);
    answerIds.push(node.id);
  }
  const resultIds = selected.flatMap((node) => {
    const result = node.callId ? results.get(node.callId) : undefined;
    return result ? [result.id] : [];
  });
  const ids = [...argsIds, ...resultIds, ...answerIds];
  const parseCall = data.fold.provider === "antigravity" ? antigravityArgs : parseArgs;
  const project = (id: number, body: string) => {
    const parsed = argsIds.has(id) ? parseCall(body) : {};
    return {
      text: body.slice(0, argsIds.has(id) ? 2000 : PREVIEW_LIMIT), chars: body.length,
      lines: argsIds.has(id) ? null : lineCount(body),
      before: text(parsed.old_string ?? parsed.oldText).slice(0, 8000) || null,
      after: text(parsed.new_string ?? parsed.newText).slice(0, 8000) || null,
    };
  };
  let bodies: Map<number, ReturnType<typeof project>>;
  if (data.bodies) bodies = await data.bodies(ids, project);
  else {
    bodies = new Map();
    for (const id of new Set(ids)) bodies.set(id, project(id, await content(data.agent.id, id, paseo)));
  }
  let remaining = 48000;
  const calls = selected.map((node) => {
    const args = bodies.get(node.id)!;
    const result = node.callId ? results.get(node.callId) : undefined;
    const body = result ? bodies.get(result.id) : undefined;
    const limit = Math.min(PREVIEW_LIMIT, remaining), value = body?.text.slice(0, limit) ?? null;
    remaining -= value?.length ?? 0;
    return { callId: node.callId ?? `node:${node.id}`, args: args.text, text: value,
      chars: body?.chars ?? null, lines: body?.lines ?? null,
      truncated: body !== undefined && body.chars > limit, before: args.before, after: args.after };
  });
  const answers = answerIds.map((id) => bodies.get(id)!);
  const answer = answers.map((body) => body.text).filter(Boolean).join("\n");
  const answerTruncated = answerNodes.length > answerIds.length || answer.length > PREVIEW_LIMIT
    || answers.some((body) => body.chars > body.text.length);
  return { requestId, contentRevision: revision, calls, answerBody: answer.slice(0, PREVIEW_LIMIT) || null, answerTruncated };
}
