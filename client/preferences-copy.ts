const en = {
  loading: "Loading preferences…", unavailable: "Preferences unavailable", shared: "Saved on this Paseo host and shared by its clients.",
  preview: "Preview", desktop: "Desktop", phone: "Phone", sample: "Sample data", context: "Context", fleet: "Fleet",
  reload: "Reload preferences",
};

export const preferencesCopy: Record<string, typeof en> = {
  en,
  zh: {
    loading: "正在载入设置…", unavailable: "无法读取设置", shared: "设置保存在当前 Paseo 主机，连接该主机的客户端共用。",
    preview: "效果预览", desktop: "桌面", phone: "手机", sample: "示例数据", context: "上下文", fleet: "编队",
    reload: "重新读取设置",
  },
  ja: {
    loading: "設定を読み込み中…", unavailable: "設定を読み込めません", shared: "設定はこの Paseo ホストに保存され、接続するクライアントで共有されます。",
    preview: "プレビュー", desktop: "デスクトップ", phone: "スマートフォン", sample: "サンプルデータ", context: "コンテキスト", fleet: "編隊",
    reload: "設定を再読み込み",
  },
  de: {
    loading: "Einstellungen werden geladen…", unavailable: "Einstellungen nicht verfügbar", shared: "Dieser Paseo-Host speichert die Einstellungen für alle verbundenen Clients.",
    preview: "Vorschau", desktop: "Desktop", phone: "Mobil", sample: "Beispieldaten", context: "Kontext", fleet: "Flotte",
    reload: "Einstellungen neu laden",
  },
  es: {
    loading: "Cargando preferencias…", unavailable: "Preferencias no disponibles", shared: "Las preferencias se guardan en este host de Paseo y se comparten con sus clientes.",
    preview: "Vista previa", desktop: "Escritorio", phone: "Móvil", sample: "Datos de ejemplo", context: "Contexto", fleet: "Flota",
    reload: "Volver a cargar las preferencias",
  },
  fr: {
    loading: "Chargement des préférences…", unavailable: "Préférences indisponibles", shared: "Les préférences sont enregistrées sur cet hôte Paseo et partagées avec ses clients.",
    preview: "Aperçu", desktop: "Ordinateur", phone: "Téléphone", sample: "Données d’exemple", context: "Contexte", fleet: "Flotte",
    reload: "Recharger les préférences",
  },
  pt: {
    loading: "Carregando preferências…", unavailable: "Preferências indisponíveis", shared: "As preferências são salvas neste host do Paseo e compartilhadas com seus clientes.",
    preview: "Prévia", desktop: "Computador", phone: "Celular", sample: "Dados de exemplo", context: "Contexto", fleet: "Frota",
    reload: "Recarregar preferências",
  },
  ru: {
    loading: "Загрузка настроек…", unavailable: "Настройки недоступны", shared: "Настройки хранятся на этом хосте Paseo и доступны его клиентам.",
    preview: "Предпросмотр", desktop: "Компьютер", phone: "Телефон", sample: "Пример данных", context: "Контекст", fleet: "Команда",
    reload: "Перезагрузить настройки",
  },
};

export type PreferencesCopy = typeof en;
