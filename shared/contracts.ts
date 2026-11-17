import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const categorySchema = z.enum(["system", "tools", "user", "inject", "skill", "assistant", "reasoning", "calls", "tool"]);
export type Category = z.infer<typeof categorySchema>;
export const categories = categorySchema.options;
export const partsSchema = z.record(categorySchema, z.number().nonnegative());
export type Parts = z.infer<typeof partsSchema>;
export const emptyParts = (): Parts => Object.fromEntries(categories.map((key) => [key, 0])) as Parts;
export const usageSchema = z.object({
  input: z.number().nonnegative(), cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(), output: z.number().nonnegative(),
  reasoning: z.number().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;
export const emptyUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
export const nodeSchema = z.object({
  id: z.number().int(), line: z.number().int(), block: z.number().int(),
  seq: z.number().optional(), goneSeq: z.number().optional(), images: z.number().optional(),
  category: categorySchema, time: z.number(), tokens: z.number(),
  title: z.string(), preview: z.string(), callId: z.string().optional(),
  error: z.boolean().optional(),
  tool: z.string().optional(), source: z.string().optional(), gone: z.number().optional(),
});
export type ContextNode = z.infer<typeof nodeSchema>;
export const requestSchema = z.object({
  id: z.string(), index: z.number(), turn: z.number(), time: z.number(), boundary: z.number(), seq: z.number().optional(),
  parts: partsSchema, usage: usageSchema, model: z.string(), duration: z.number().nullable(),
  prompt: z.string(), response: z.string(), costUsd: z.number().nullable(),
  usageFields: z.array(z.enum(["input", "cacheRead", "cacheWrite", "output", "reasoning"])).optional(),
  estimatedModelMs: z.number().nonnegative().optional(), estimatedTtftMs: z.number().nonnegative().optional(),
  estimatedModelStart: z.number().optional(), estimatedModelEnd: z.number().optional(),
});
export type Request = z.infer<typeof requestSchema>;
export const eventSchema = z.object({
  id: z.number(), time: z.number(), seq: z.number().optional(), kind: z.enum(["compaction", "prune", "inject", "model", "mode", "skill"]),
  title: z.string(), detail: z.string(),
});
export type ContextEvent = z.infer<typeof eventSchema>;
export const fileSchema = z.object({
  id: z.number(), time: z.number(), path: z.string(),
  kind: z.enum(["read", "write", "search", "image"]), tool: z.string(),
  added: z.number(), removed: z.number(), error: z.boolean(),
});
export type FileActivity = z.infer<typeof fileSchema>;
export const commandSchema = z.object({
  id: z.number(), time: z.number(), tool: z.string(), command: z.string(), cwd: z.string(),
  programs: z.array(z.string()), status: z.enum(["running", "completed", "failed", "killed"]),
  exit: z.number().nullable(), duration: z.number().nullable(), outputNode: z.number().nullable(),
  outputNodes: z.array(z.number()).optional(),
});
export type Command = z.infer<typeof commandSchema>;
export const agentSchema = z.object({
  id: z.string(), workspaceId: z.string().nullable(), parentId: z.string().nullable(),
  title: z.string(), cwd: z.string(), provider: z.string(), model: z.string(),
  sessionId: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
  archived: z.boolean(), running: z.boolean(),
});
export type Agent = z.infer<typeof agentSchema>;
export const tallySchema = z.object({ name: z.string(), count: z.number(), last: z.number() });
export type Tally = z.infer<typeof tallySchema>;
export const summarySchema = z.object({
  agent: agentSchema, source: z.enum(["native", "timeline", "unavailable"]),
  usage: usageSchema, turns: z.number(), steps: z.number(), humanInputs: z.number(),
  toolCalls: z.number(), images: z.number(), contextTokens: z.number().nullable(),
  contextWindow: z.number().nullable(), maxOutput: z.number().nullable(), parts: partsSchema,
  costUsd: z.number().nullable(), costComplete: z.boolean(), modelMs: z.number(), toolMs: z.number(),
  ttftMs: z.number().optional(), timedOutputTokens: z.number().optional(),
  intervals: z.array(z.object({ start: z.number(), end: z.number(), kind: z.enum(["model", "tools"]) })).optional(),
  wallMs: z.number(), tools: z.array(tallySchema), skills: z.array(tallySchema),
  programs: z.array(tallySchema), notices: z.array(z.string()),
  activity: z.array(z.object({ time: z.number(), tools: z.array(tallySchema), skills: z.array(tallySchema), programs: z.array(tallySchema) })),
});
export type Summary = z.infer<typeof summarySchema>;
export const snapshotSchema = z.object({
  summary: summarySchema, requests: z.array(requestSchema), events: z.array(eventSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const agentInput = z.object({ agentId: z.string().min(1) });
export const snapshotRpc = defineRpc({ name: "context.snapshot", input: agentInput, output: snapshotSchema });
export const browserRpc = defineRpc({
  name: "context.browser",
  input: agentInput.extend({
    requestId: z.string().optional(), category: categorySchema.optional(),
    query: z.string().default(""), sort: z.enum(["order", "size", "name"]).default("order"),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40),
  }),
  output: z.object({ items: z.array(nodeSchema), total: z.number() }),
});
export const contentRpc = defineRpc({
  name: "context.content", input: agentInput.extend({
    nodeId: z.number().int().nonnegative(), offset: z.number().int().nonnegative().default(0),
  }),
  output: z.object({ text: z.string(), totalChars: z.number(), nextOffset: z.number().nullable() }),
});
export const activityRpc = defineRpc({
  name: "context.activity", input: agentInput.extend({
    kind: z.enum(["files", "commands"]), query: z.string().default(""),
    filter: z.string().default("all"), sort: z.enum(["latest", "count", "lines", "path", "name"]).default("latest"),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40),
  }), output: z.object({ files: z.array(fileSchema), commands: z.array(commandSchema), total: z.number() }),
});
export const scopeSchema = z.object({
  range: z.enum(["today", "7d", "30d", "all", "custom"]).default("7d"),
  start: z.string().default(""), end: z.string().default(""), day: z.string().default(""),
  query: z.string().default(""), group: z.string().default(""),
  coverage: z.enum(["all", "active", "archived"]).default("all"),
  sort: z.enum(["recent", "tokens", "context"]).default("recent"),
  pick: z.enum(["", "tools", "skills", "programs"]).default(""), name: z.string().default(""),
});
export type Scope = z.infer<typeof scopeSchema>;
export const overviewRpc = defineRpc({
  name: "context.overview",
  input: scopeSchema.extend({ offset: z.number().int().nonnegative().default(0) }),
  output: z.object({
    sessions: z.array(summarySchema), total: z.number(), scanned: z.number(), failed: z.number(),
    tokens: z.number(), turns: z.number(), toolCalls: z.number(), wallMs: z.number(),
    costUsd: z.number().nullable(), costComplete: z.boolean(), cacheRead: z.number(), input: z.number(),
    parts: partsSchema, groups: z.array(z.string()),
    days: z.array(z.object({ day: z.string(), tokens: z.number(), costUsd: z.number().nullable(), sessions: z.number() })),
    tools: z.array(tallySchema), skills: z.array(tallySchema), programs: z.array(tallySchema),
  }),
});
export const fleetRpc = defineRpc({
  name: "context.fleet", input: agentInput,
  output: z.object({ rootId: z.string(), members: z.array(summarySchema), failed: z.number() }),
});
export const collaborationRecordSchema = z.object({
  id: z.string(), agentId: z.string(), nodeId: z.number(), time: z.number(),
  kind: z.enum(["delegation", "message", "task", "report"]), title: z.string(), to: z.string(),
  taskId: z.string(), status: z.enum(["pending", "in_progress", "completed", "failed", "unknown"]),
  blockedBy: z.array(z.string()),
});
export type CollaborationRecord = z.infer<typeof collaborationRecordSchema>;
export const collaborationRpc = defineRpc({
  name: "context.collaboration", input: agentInput,
  output: z.object({ records: z.array(collaborationRecordSchema), failed: z.number() }),
});

export const preferenceSchema = z.object({
  defaultPlacement: z.enum(["all", "tab", "sidebar", "hide"]).default("all"),
  insightsEntry: z.boolean().default(true), fleetTab: z.boolean().default(true),
  defaultOverviewRange: z.enum(["today", "7d", "30d"]).default("7d"),
  defaultGranularity: z.enum(["step", "turn"]).default("step"),
  defaultTrendMode: z.enum(["total", "delta"]).default("total"),
  defaultDeltaBase: z.enum(["step", "turn"]).default("step"),
  defaultToolSort: z.enum(["size", "count", "name"]).default("size"),
  defaultFileSort: z.enum(["count", "lines", "latest", "path", "name"]).default("latest"),
  defaultDurationCurve: z.boolean().default(true),
  overviewAutoSteps: z.enum(["off", "100", "200", "300"]).default("200"),
  promptPrefix: z.string().max(100000).default(""), promptSuffix: z.string().max(100000).default(""),
});
export type Preferences = z.infer<typeof preferenceSchema>;
export const preferences = defineSettings({ id: "context", scope: "host", version: 1, schema: preferenceSchema });
export const preferencesRpc = defineRpc({ name: "context.preferences", input: z.object({}), output: preferenceSchema });
