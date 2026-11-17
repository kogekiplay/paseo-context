const states: Record<string, [string, string]> = {
  zh: ["失败", "已取消"], en: ["Failed", "Canceled"], ja: ["失敗", "キャンセル済み"],
  es: ["Fallida", "Cancelada"], fr: ["Échec", "Annulée"], de: ["Fehlgeschlagen", "Abgebrochen"],
  ru: ["Ошибка", "Отменено"], pt: ["Falhou", "Cancelada"],
};
const statistics: Record<string, string[]> = {
  zh: ["正在加载记录…", "展开时加载记录", "记录加载失败，点击重试", "已压缩；详细指标未记录", "按会话时间戳估算", "输入与缓存合计（Codex 输入已包含缓存）", "缓存读 ÷ 提示词输入合计"],
  en: ["Loading captured details…", "Details load on expansion", "Details failed to load; click to retry", "Compacted; metrics not recorded", "Estimated from session timestamps", "Total prompt input including cache (Codex input already includes cache)", "Cache read ÷ total prompt input"],
  ja: ["記録を読み込み中…", "展開時に記録を読み込み", "読み込み失敗。クリックで再試行", "圧縮済み・詳細指標なし", "セッション時刻からの推定", "キャッシュを含む入力合計", "キャッシュ読込 ÷ 入力合計"],
  es: ["Cargando detalles…", "Los detalles se cargan al expandir", "Error al cargar; pulsa para reintentar", "Compactado; métricas no registradas", "Estimado según marcas de tiempo", "Entrada total incluida la caché", "Lectura de caché ÷ entrada total"],
  fr: ["Chargement des détails…", "Détails chargés à l’ouverture", "Échec du chargement ; cliquez pour réessayer", "Compacté ; métriques non enregistrées", "Estimation selon les horodatages", "Entrée totale, cache compris", "Lecture du cache ÷ entrée totale"],
  de: ["Details werden geladen…", "Details beim Aufklappen laden", "Laden fehlgeschlagen; zum Wiederholen klicken", "Komprimiert; Messwerte fehlen", "Aus Sitzungszeitstempeln geschätzt", "Gesamte Eingabe einschließlich Cache", "Cache-Lesen ÷ gesamte Eingabe"],
  ru: ["Загрузка данных…", "Данные загружаются при раскрытии", "Ошибка загрузки; нажмите для повтора", "Сжато; метрики не записаны", "Оценка по временным меткам", "Весь ввод, включая кэш", "Чтение кэша ÷ весь ввод"],
  pt: ["Carregando detalhes…", "Detalhes carregados ao expandir", "Falha ao carregar; clique para repetir", "Compactado; métricas não registradas", "Estimado por horários da sessão", "Entrada total incluindo cache", "Leitura do cache ÷ entrada total"],
};
const statisticsKeys = ["paseo.details.loading", "paseo.details.unloaded", "paseo.details.error", "paseo.compaction.complete", "paseo.timing.estimate", "column.context.title", "column.cache.title"];
export function hostMessage(locale: string, key: string): string | undefined {
  const language = locale.split("-")[0], values = states[language] ?? states.en;
  const index = statisticsKeys.indexOf(key);
  return key === "fleet.task.failed" ? values[0] : key === "fleet.task.canceled" ? values[1]
    : index >= 0 ? (statistics[language] ?? statistics.en)[index] : undefined;
}
