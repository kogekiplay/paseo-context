/** Paseo's type seats for the unmodified static Statistics view. */
import type { StatsSnapshot } from "../../../shared/core/stats-contract";
import type { StatsTranslate } from "./locales";

export interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
export interface SessionStatsProjection {
  turns: number; steps: number; llmMs: number; toolMs: number;
  ttftSteps: number; ttftMs: number; decodeMs: number; decodeTokens: number;
}
export interface TokenUsageProjection {
  uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number;
}
export interface ConvViewProps {
  useProjection: {
    (key: "sessionStats"): SessionStatsProjection | undefined;
    (key: "tokenUsage"): TokenUsageProjection | undefined;
  };
}
export type InjectFace<T> = Omit<T, "hooks"> & {
  useStats<R>(select: (snapshot: StatsSnapshot) => R): R;
};
export type PropsLocale<_Namespace> = { t: StatsTranslate };
