import { useState } from "react";
import { Donut } from "../src/client/components/donut";
import { makeStatsTokens } from "../src/client/components/statsTokens";
import { makeStatsTiming } from "../src/client/components/statsTiming";
import { useContextSession } from "../src/client/sessionData";
import type { SessionStandardProps } from "../src/client/services";
import type { ViewKit } from "../src/client/viewkit";

const TEXT = {
  en: ["Statistics", "Requests", "Input", "Output", "Cache read", "Duration", "Previous", "Next", "Usage is provider reported when available. Composition, prices and observable timing are estimates; missing provider fields remain unavailable."],
  zh: ["统计", "请求明细", "输入", "输出", "缓存读取", "耗时", "上一页", "下一页", "可用的用量来自提供方报告；组成、价格和可观测耗时为估算，提供方未记录的数据保持未知。"],
  ja: ["統計", "リクエスト", "入力", "出力", "キャッシュ読取", "所要時間", "前へ", "次へ", "取得可能な使用量はプロバイダーの報告値です。構成・価格・観測時間は推定で、未記録の項目は不明です。"],
  es: ["Estadísticas", "Solicitudes", "Entrada", "Salida", "Lectura de caché", "Duración", "Anterior", "Siguiente", "El uso disponible procede del proveedor. La composición, los precios y los tiempos observables son estimaciones; los campos ausentes no están disponibles."],
  fr: ["Statistiques", "Requêtes", "Entrée", "Sortie", "Lecture du cache", "Durée", "Précédent", "Suivant", "L’usage disponible est rapporté par le fournisseur. Composition, prix et durées observables sont estimés ; les champs absents restent inconnus."],
  de: ["Statistik", "Anfragen", "Eingabe", "Ausgabe", "Cache-Lesen", "Dauer", "Zurück", "Weiter", "Verfügbare Nutzungswerte stammen vom Anbieter. Zusammensetzung, Preise und beobachtbare Zeiten sind Schätzungen; fehlende Felder bleiben unbekannt."],
  ru: ["Статистика", "Запросы", "Ввод", "Вывод", "Чтение кэша", "Время", "Назад", "Далее", "Доступный расход сообщает провайдер. Состав, цены и наблюдаемое время оценочные; отсутствующие поля остаются неизвестными."],
  pt: ["Estatísticas", "Solicitações", "Entrada", "Saída", "Leitura de cache", "Duração", "Anterior", "Próxima", "O uso disponível é informado pelo provedor. Composição, preços e tempos observáveis são estimativas; campos ausentes permanecem indisponíveis."],
};
const PAGE_SIZE = 40;
export function makeStatisticsView(kit: ViewKit) {
  const Tokens = makeStatsTokens(kit, Donut), Timing = makeStatsTiming(kit, Donut);
  return function Statistics(props: SessionStandardProps & { locale: string; notices: readonly string[] }) {
    const { data, usage, breakdown } = useContextSession(props);
    const [page, setPage] = useState(0);
    const labels = TEXT[props.locale.split("-")[0] as keyof typeof TEXT] ?? TEXT.en;
    if (!data) return <div className="pc-status">{kit.t("trend.empty")}</div>;
    const pages = Math.max(1, Math.ceil(data.requests.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
    const end = data.requests.length - current * PAGE_SIZE;
    const rows = data.requests.slice(Math.max(0, end - PAGE_SIZE), end).reverse();
    return <div className="lc-root pc-statistics">
      <div className="lc-card">
        <div className="lc-card-title">{labels[0]} · {data.provider} · {data.model}</div>
        <div className="pc-statistics-totals">
          <span>{kit.t("stats.turns")} <strong>{kit.fmt(data.counts?.turns)}</strong></span>
          <span>{kit.t("stats.steps")} <strong>{kit.fmt(data.counts?.steps)}</strong></span>
          <span>{kit.t("tokens.title")} <strong>{usage ? kit.fmt(usage.uncachedInputTokens + usage.cacheReadTokens + (usage.cacheWriteTokens ?? 0) + usage.outputTokens) : "—"}</strong></span>
          <span>{kit.t("stats.cost")} <strong>{data.costRead?.ready && data.costRead.usd !== null ? `$${data.costRead.usd.toFixed(4)}` : "—"}</strong></span>
        </div>
        <p className="lc-detail-note">{labels[8]}</p>
        {props.notices.map((notice) => <p key={notice} className="lc-detail-note">{notice}</p>)}
      </div>
      <div className="lc-cols lc-head">
        {usage ? <Tokens usage={usage} current={data.current} breakdown={breakdown} generatedReasoning={data.generatedReasoning}
          generatedAnswerTokens={data.generatedAnswerTokens} generatedCallTokens={data.generatedCallTokens} />
          : <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]"><div className="lc-card-title">{kit.t("tokens.title")} · —</div><p className="lc-detail-note">{labels[8]}</p></div>}
        <Timing timing={data.timing ?? null} spans={data.spans} locale={props.locale} />
      </div>
      <div className="lc-card">
        <div className="lc-card-title">{labels[1]} <span>{kit.fmt(data.requests.length)}</span></div>
        <div className="pc-statistics-table">
          <table><thead><tr><th>{kit.t("stats.turns")} / {kit.t("stats.steps")}</th><th>{labels[2]}</th><th>{labels[3]}</th><th>{labels[4]}</th><th>{labels[5]}</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.seq}><td>{r.turn ?? "—"} / {r.step ?? "—"}</td>
              <td>{kit.fmt(r.prompt)}</td><td>{kit.fmt(r.output)}</td><td>{kit.fmt(r.cacheRead)}</td><td>{r.activeMs === undefined ? "—" : kit.fmtDuration(r.activeMs)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="pc-statistics-pages"><button disabled={current === 0} onClick={() => setPage(current - 1)}>{labels[6]}</button>
          <span>{current + 1} / {pages}</span><button disabled={current === pages - 1} onClick={() => setPage(current + 1)}>{labels[7]}</button></div>
      </div>
    </div>;
  };
}
