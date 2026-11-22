import { StatsView } from "./vendor/statistics/StatsView";
import * as dictionaries from "./vendor/statistics/locales";
import type { StatsKey, StatsTranslate } from "./vendor/statistics/locales";
import type { ImageAttachmentRef, StatsSnapshot, StatsRequestDetails as Details, StatsStepMetrics } from "../shared/core/stats-contract";
import type { SessionStandardProps } from "../src/client/services";
import type { ViewKit } from "../src/client/viewkit";
import { call } from "./bridge";
import { hostMessage } from "./host-messages";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const noOlder = async () => "exhausted" as const;
const cancel = () => {};
const empty: StatsSnapshot = { turns: [], stepCount: 0 };
export const MAX_CACHED_DETAILS = 64;
export const MAX_CACHED_DETAIL_CHARS = 3 * 1024 * 1024;

type StatusEntry = { revision: string; status: "loading" | "error" };

export function detailCharSize(detail: Details): number {
  let chars = detail.answerBody?.length ?? 0;
  for (const entry of detail.calls) {
    chars += (entry.args?.length ?? 0)
      + (entry.text?.length ?? 0)
      + (entry.before?.length ?? 0)
      + (entry.after?.length ?? 0);
  }
  return chars;
}

function setBoundedStatus(previous: Map<string, StatusEntry>, key: string, value: StatusEntry): Map<string, StatusEntry> {
  const next = new Map(previous);
  next.delete(key);
  next.set(key, value);
  while (next.size > MAX_CACHED_DETAILS) next.delete(next.keys().next().value!);
  return next;
}

export function setBoundedDetails(
  previous: Map<string, Details>,
  key: string,
  value: Details,
  maxEntries = MAX_CACHED_DETAILS,
  maxChars = MAX_CACHED_DETAIL_CHARS,
  onEvict?: (keys: string[]) => void,
): Map<string, Details> {
  const next = new Map(previous);
  next.delete(key);
  next.set(key, value);
  let totalChars = 0;
  for (const entry of next.values()) totalChars += detailCharSize(entry);
  const evicted: string[] = [];
  while (next.size > maxEntries || (totalChars > maxChars && next.size > 1)) {
    const oldestKey = next.keys().next().value!;
    const oldest = next.get(oldestKey)!;
    next.delete(oldestKey);
    evicted.push(oldestKey);
    totalChars -= detailCharSize(oldest);
  }
  if (evicted.length > 0 && onEvict) onEvict(evicted);
  return next;
}

export function makeStatisticsView(_kit: ViewKit) {
  return function Statistics(props: SessionStandardProps & {
    locale: string;
    snapshot: StatsSnapshot | null;
    loadImage?: (attachment: ImageAttachmentRef) => Promise<string>;
  }) {
    const [details, setDetails] = useState(() => new Map<string, Details>());
    const [statuses, setStatuses] = useState(() => new Map<string, StatusEntry>());
    const pending = useRef(new Map<string, { revision: string; controller: AbortController }>());
    const expanded = useRef(new Set<string>());
    const prevSessionId = useRef(props.sessionId);
    const source = props.snapshot ?? empty;

    const stepIndex = useMemo(() => {
      const map = new Map<string, StatsStepMetrics>();
      for (const turn of source.turns) {
        for (const step of turn.steps) {
          if (step.sourceId) map.set(step.sourceId, step);
        }
      }
      return map;
    }, [source]);

    const latest = useRef({ stepIndex, details, sessionId: props.sessionId });
    latest.current = { stepIndex, details, sessionId: props.sessionId };

    useEffect(() => {
      if (prevSessionId.current === props.sessionId) return;
      prevSessionId.current = props.sessionId;
      for (const { controller } of pending.current.values()) controller.abort();
      pending.current.clear();
      expanded.current.clear();
      setDetails(new Map());
      setStatuses(new Map());
    }, [props.sessionId]);

    useEffect(() => () => {
      for (const { controller } of pending.current.values()) controller.abort();
      pending.current.clear();
      expanded.current.clear();
    }, []);

    const dictionary = dictionaries[props.locale.split("-")[0] as "zh" | "en"] ?? dictionaries.en;
    const t: StatsTranslate = useCallback((key, params = {}) => {
      let value = hostMessage(props.locale, key) ?? dictionary[key as StatsKey] ?? dictionaries.en[key as StatsKey] ?? key;
      for (const [name, content] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(content));
      return value;
    }, [props.locale, dictionary]);

    const snapshot = useMemo(() => ({
      ...source,
      turns: source.turns.map((turn) => ({
        ...turn,
        steps: turn.steps.map((step) => {
          const detail = step.sourceId ? details.get(step.sourceId) : undefined;
          const status = step.sourceId ? statuses.get(step.sourceId) : undefined;
          return detail && detail.contentRevision === step.contentRevision
            ? {
              ...step,
              detailsState: "ready" as const,
              answerBody: detail.answerBody,
              answerTruncated: detail.answerTruncated,
              calls: step.calls.map((item) => ({ ...item, ...detail.calls.find((entry) => entry.callId === item.callId) })),
            }
            : { ...step, detailsState: status && status.revision === step.contentRevision ? status.status : step.detailsState };
        }),
      })),
    }), [source, details, statuses]);

    const load = useCallback((id: string) => {
      const step = latest.current.stepIndex.get(id);
      if (!step?.contentRevision || latest.current.details.get(id)?.contentRevision === step.contentRevision) return;
      const revision = step.contentRevision, old = pending.current.get(id);
      if (old?.revision === revision) return;
      old?.controller.abort();
      const controller = new AbortController();
      pending.current.set(id, { revision, controller });
      setStatuses((previous) => setBoundedStatus(previous, id, { revision, status: "loading" }));
      void call("statistics.details", { agentId: latest.current.sessionId, requestId: id }, { signal: controller.signal })
        .then((detail: Details) => {
          const current = latest.current.stepIndex.get(id);
          if (controller.signal.aborted) return;
          if (detail.requestId !== id || detail.contentRevision !== revision || current?.contentRevision !== revision) {
            if (current?.contentRevision === revision) {
              setStatuses((previous) => {
                if (previous.get(id)?.revision !== revision) return previous;
                const next = new Map(previous);
                next.delete(id);
                return next;
              });
            }
            return;
          }
          setDetails((previous) => setBoundedDetails(
            previous, id, detail, MAX_CACHED_DETAILS, MAX_CACHED_DETAIL_CHARS,
            (evictedKeys) => {
              for (const evictedId of evictedKeys) {
                expanded.current.delete(evictedId);
                pending.current.get(evictedId)?.controller.abort();
                pending.current.delete(evictedId);
              }
            },
          ));
          setStatuses((previous) => {
            if (!previous.has(id)) return previous;
            const next = new Map(previous);
            next.delete(id);
            return next;
          });
        }).catch(() => {
          if (!controller.signal.aborted) setStatuses((previous) => setBoundedStatus(previous, id, { revision, status: "error" }));
        }).finally(() => { if (pending.current.get(id)?.controller === controller) pending.current.delete(id); });
    }, []);

    useEffect(() => {
      for (const id of [...expanded.current]) {
        if (!stepIndex.has(id)) {
          expanded.current.delete(id);
          pending.current.get(id)?.controller.abort();
          pending.current.delete(id);
          continue;
        }
        load(id);
      }
    }, [stepIndex, load]);

    const loadDetails = (target: EventTarget | null) => {
      const row = (target as Element | null)?.closest?.("tr[data-paseo-request]");
      const id = row?.getAttribute("data-paseo-request");
      if (!id) return;
      const hasQuery = typeof row?.querySelector === "function";
      const toggle = hasQuery ? row.querySelector("button[aria-expanded]") : null;
      const isDetailRow = hasQuery && row.querySelector("td[colspan]") !== null;
      if (hasQuery && !toggle && !isDetailRow) return;
      if (toggle?.getAttribute("aria-expanded") === "true") {
        expanded.current.delete(id);
        pending.current.get(id)?.controller.abort();
        pending.current.delete(id);
        return;
      }
      expanded.current.delete(id);
      expanded.current.add(id);
      while (expanded.current.size > MAX_CACHED_DETAILS) {
        const oldest = expanded.current.values().next().value!;
        expanded.current.delete(oldest);
        pending.current.get(oldest)?.controller.abort();
        pending.current.delete(oldest);
      }
      load(id);
    };

    const loadImage = useCallback(
      (attachment: ImageAttachmentRef) => props.loadImage
        ? props.loadImage(attachment)
        : call("api/paseo-context/image", { sessionId: props.sessionId, attachmentId: attachment.attachmentId }),
      [props.loadImage, props.sessionId],
    );

    return <div className="pc-statistics" onClickCapture={(event) => loadDetails(event.target)}
      title="Paseo: provider fields that were not recorded remain unavailable.">
      <StatsView useStats={(select) => select(snapshot)} t={t} loadOlder={noOlder} cancel={cancel}
        useProjection={() => undefined}
        loadImage={loadImage} />
    </div>;
  };
}
