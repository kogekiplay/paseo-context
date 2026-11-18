const en = {
  loading: "Loading preferences…", unavailable: "Preferences unavailable", shared: "Saved on this Paseo host and shared by its clients.",
  preview: "Preview", desktop: "Desktop", phone: "Phone", sample: "Sample data", chat: "Chat", context: "Context", fleet: "Fleet",
  promptHint: "The prefix and suffix apply to agents created after saving.", save: "Save", reload: "Reload preferences",
  reloadPrompts: "Reload saved prompts", conflict: "These prompts changed on another client. Reload them before editing again.",
};

export const preferencesCopy: Record<string, typeof en> = {
  en,
  zh: {
    loading: "正在载入设置…", unavailable: "无法读取设置", shared: "设置保存在当前 Paseo 主机，连接该主机的客户端共用。",
    preview: "效果预览", desktop: "桌面", phone: "手机", sample: "示例数据", chat: "会话", context: "上下文", fleet: "编队",
    promptHint: "前缀和后缀只会添加到保存后新建的 Agent 的系统提示词。", save: "保存", reload: "重新读取设置",
    reloadPrompts: "重新载入已保存的提示词", conflict: "提示词已在其他客户端更新，请重新载入后再编辑。",
  },
  ja: {
    loading: "設定を読み込み中…", unavailable: "設定を読み込めません", shared: "設定はこの Paseo ホストに保存され、接続するクライアントで共有されます。",
    preview: "プレビュー", desktop: "デスクトップ", phone: "スマートフォン", sample: "サンプルデータ", chat: "会話", context: "コンテキスト", fleet: "編隊",
    promptHint: "接頭辞と接尾辞は保存後に作成したエージェントに適用されます。", save: "保存", reload: "設定を再読み込み",
    reloadPrompts: "保存済みプロンプトを再読み込み", conflict: "別のクライアントでプロンプトが更新されました。再読み込みしてから編集してください。",
  },
  de: {
    loading: "Einstellungen werden geladen…", unavailable: "Einstellungen nicht verfügbar", shared: "Dieser Paseo-Host speichert die Einstellungen für alle verbundenen Clients.",
    preview: "Vorschau", desktop: "Desktop", phone: "Mobil", sample: "Beispieldaten", chat: "Chat", context: "Kontext", fleet: "Flotte",
    promptHint: "Präfix und Suffix gelten für Agenten, die nach dem Speichern erstellt werden.", save: "Speichern", reload: "Einstellungen neu laden",
    reloadPrompts: "Gespeicherte Prompts neu laden", conflict: "Die Prompts wurden auf einem anderen Client geändert. Lade sie vor dem Bearbeiten neu.",
  },
  es: {
    loading: "Cargando preferencias…", unavailable: "Preferencias no disponibles", shared: "Las preferencias se guardan en este host de Paseo y se comparten con sus clientes.",
    preview: "Vista previa", desktop: "Escritorio", phone: "Móvil", sample: "Datos de ejemplo", chat: "Chat", context: "Contexto", fleet: "Flota",
    promptHint: "El prefijo y el sufijo se aplican a los agentes creados después de guardar.", save: "Guardar", reload: "Volver a cargar las preferencias",
    reloadPrompts: "Volver a cargar los prompts guardados", conflict: "Otro cliente modificó los prompts. Vuelve a cargarlos antes de editar.",
  },
  fr: {
    loading: "Chargement des préférences…", unavailable: "Préférences indisponibles", shared: "Les préférences sont enregistrées sur cet hôte Paseo et partagées avec ses clients.",
    preview: "Aperçu", desktop: "Ordinateur", phone: "Téléphone", sample: "Données d’exemple", chat: "Discussion", context: "Contexte", fleet: "Flotte",
    promptHint: "Le préfixe et le suffixe s’appliquent aux agents créés après l’enregistrement.", save: "Enregistrer", reload: "Recharger les préférences",
    reloadPrompts: "Recharger les prompts enregistrés", conflict: "Un autre client a modifié les prompts. Rechargez-les avant de les modifier.",
  },
  pt: {
    loading: "Carregando preferências…", unavailable: "Preferências indisponíveis", shared: "As preferências são salvas neste host do Paseo e compartilhadas com seus clientes.",
    preview: "Prévia", desktop: "Computador", phone: "Celular", sample: "Dados de exemplo", chat: "Conversa", context: "Contexto", fleet: "Frota",
    promptHint: "O prefixo e o sufixo se aplicam aos agentes criados depois de salvar.", save: "Salvar", reload: "Recarregar preferências",
    reloadPrompts: "Recarregar prompts salvos", conflict: "Os prompts foram alterados em outro cliente. Recarregue-os antes de editar.",
  },
  ru: {
    loading: "Загрузка настроек…", unavailable: "Настройки недоступны", shared: "Настройки хранятся на этом хосте Paseo и доступны его клиентам.",
    preview: "Предпросмотр", desktop: "Компьютер", phone: "Телефон", sample: "Пример данных", chat: "Чат", context: "Контекст", fleet: "Команда",
    promptHint: "Префикс и суффикс применяются к агентам, созданным после сохранения.", save: "Сохранить", reload: "Перезагрузить настройки",
    reloadPrompts: "Загрузить сохранённые промпты", conflict: "Промпты изменены в другом клиенте. Загрузите их заново перед редактированием.",
  },
};

export type PreferencesCopy = typeof en;
