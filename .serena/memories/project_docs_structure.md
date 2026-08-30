# Документация проекта: структура после реструктуризации 2026-08-30

CLAUDE.md ужат с 680 КБ до ~24 КБ («конституция»: Think Before Coding, «Никакого MVP», graphify-first, правило docs/, принципы, карта движков, несущие правила-выжимки, команды, аккаунты). **Канон архитектуры — папка `docs/`** (46 тематических файлов + индекс `docs/README.md`): сквозные конвенции (module_graph, api_conventions, contract_boundary, security, web_conventions, testing_verify_suite, dev_environment, environment_variables, playbook_new_service, platform_gotchas), 15 движков (`*_engine.md` + rich_cards/quick_actions), 18 сервисов, roadmap.

Правила:
- Перед работой агент читает `docs/README.md` + релевантные доки; несоответствие док↔код — сообщить и предложить фикс; в конце подхода — актуализировать доки.
- Стиль доков: ТОЛЬКО текущее состояние + вечные правила/ловушки, без дат и истории (исключение — roadmap.md).
- Источники правды: docs/ = канон; CLAUDE.md = несущие правила; **Serena memories = дизайн-исследования и история решений (новые архитектурные факты сюда НЕ дублировать)**; auto-memory = личные заметки агента.
- Новое синхронное ребро модулей → docs/module_graph.md (карта переехала туда из CLAUDE.md).

Перемещения: GAP-ANALYSIS-v2.md → `docs/gap_analysis_v2.md` (git mv); старый CLAUDE.md целиком — `docs/archive/claude-md-2026-08-30.md` (не обновляется); `.claude/CLAUDE.md` (graphify-заметка) слит в корневой CLAUDE.md §3 и удалён.
