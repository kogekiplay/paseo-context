import { StatsView } from "./vendor/statistics/StatsView";
import * as dictionaries from "./vendor/statistics/locales";
import type { StatsKey, StatsTranslate } from "./vendor/statistics/locales";
import type { StatsSnapshot, StatsRequestDetails as Details } from "../shared/core/stats-contract";
import type { SessionStandardProps } from "../src/client/services";
import type { ViewKit } from "../src/client/viewkit";
import { call } from "./bridge";
import { hostMessage } from "./host-messages";
import { useCallback, useEffect, useRef, useState } from "react";

const noOlder = async () => "exhausted" as const;
const cancel = () => {};
const empty: StatsSnapshot = { turns: [], stepCount: 0 };
export function makeStatisticsView(_kit: ViewKit) {
  return function Statistics(props: SessionStandardProps & { locale: string; snapshot: StatsSnapshot | null }) {
    const [details, setDetails] = useState(new Map<string, Details>());
    const [statuses, setStatuses] = useState(new Map<string, { revision: string; status: "loading" | "error" }>());
    const pending = useRef(new Map<string, { revision: string; controller: AbortController }>());
    const seen = useRef(new Set<string>());
    const source = props.snapshot ?? empty;
    const latest = useRef({ source, details, sessionId: props.sessionId });
    latest.current = { source, details, sessionId: props.sessionId };
    useEffect(() => () => {
      for (const { controller } of pending.current.values()) controller.abort();
      pending.current.clear();
      seen.current.clear();
    }, []);
    const dictionary = dictionaries[props.locale.split("-")[0] as "zh" | "en"] ?? dictionaries.en;
    const t: StatsTranslate = (key, params = {}) => {
      let value = hostMessage(props.locale, key) ?? dictionary[key as StatsKey] ?? dictionaries.en[key as StatsKey] ?? key;
      for (const [name, content] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(content));
      return value;
    };
    const snapshot = { ...source, turns: source.turns.map((turn) => ({ ...turn, steps: turn.steps.map((step) => {
      const detail = step.sourceId ? details.get(step.sourceId) : undefined;
      const status = step.sourceId ? statuses.get(step.sourceId) : undefined;
      return detail && detail.contentRevision === step.contentRevision ? { ...step, detailsState: "ready" as const,
        answerBody: detail.answerBody, answerTruncated: detail.answerTruncated,
        calls: step.calls.map((item) => ({ ...item, ...detail.calls.find((call) => call.callId === item.callId) })) }
        : { ...step, detailsState: status && status.revision === step.contentRevision ? status.status : step.detailsState };
    }) })) };
    const load = useCallback((id: string) => {
      const step = latest.current.source.turns.flatMap((turn) => turn.steps).find((step) => step.sourceId === id);
      if (!step?.contentRevision || latest.current.details.get(id)?.contentRevision === step.contentRevision) return;
      const revision = step.contentRevision, old = pending.current.get(id);
      if (old?.revision === revision) return;
      old?.controller.abort();
      const controller = new AbortController();
      pending.current.set(id, { revision, controller });
      setStatuses((previous) => {
        const next = new Map(previous); next.set(id, { revision, status: "loading" });
        while (next.size > 64) next.delete(next.keys().next().value!);
        return next;
      });
      void call("statistics.details", { agentId: latest.current.sessionId, requestId: id }, { signal: controller.signal })
        .then((detail: Details) => {
          const current = latest.current.source.turns.flatMap((turn) => turn.steps).find((step) => step.sourceId === id);
          if (controller.signal.aborted || detail.requestId !== id || detail.contentRevision !== revision || current?.contentRevision !== revision) return;
          setDetails((previous) => {
            const next = new Map(previous); next.delete(id); next.set(id, detail);
            while (next.size > 64) next.delete(next.keys().next().value!);
            return next;
          });
        }).catch(() => {
          if (!controller.signal.aborted) setStatuses((previous) => new Map(previous).set(id, { revision, status: "error" }));
        }).finally(() => { if (pending.current.get(id)?.controller === controller) pending.current.delete(id); });
    }, []);
    useEffect(() => {
      for (const id of seen.current) load(id);
    }, [source, load]);
    const loadDetails = (target: EventTarget | null) => {
      const id = (target as Element | null)?.closest?.("tr[data-paseo-request]")?.getAttribute("data-paseo-request");
      if (!id) return;
      seen.current.delete(id); seen.current.add(id);
      while (seen.current.size > 64) {
        const oldest = seen.current.values().next().value!;
        seen.current.delete(oldest); pending.current.get(oldest)?.controller.abort(); pending.current.delete(oldest);
      }
      load(id);
    };
    return <div className="pc-statistics" onClickCapture={(event) => loadDetails(event.target)}
      title="Paseo: provider fields that were not recorded remain unavailable.">
      <StatsView useStats={(select) => select(snapshot)} t={t} loadOlder={noOlder} cancel={cancel}
        useProjection={() => undefined}
        loadImage={(attachment) => call("api/paseo-context/image", { sessionId: props.sessionId, attachmentId: attachment.attachmentId })} />
    </div>;
  };
}
