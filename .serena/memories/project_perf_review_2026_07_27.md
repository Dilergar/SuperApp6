# Перф-ревью нового дизайна 2026-07-27 + волна 2 («делай все 5»)

## Волна 1 — диагноз и лечение «кликов по 5–7с»
Причина — dev-webpack (`ensure-page` 6.3–10.9с/маршрут, ~4.5МБ дублированного корневого графа на чанк), НЕ CSS/рантайм. Сделано: `next dev --turbopack` (+launch.json; dev:webpack запасной), `app/loading.tsx` (cookies() в корне = всё динамическое, клик молчал), похудение корневого графа (CallsWatcher→dynamic IncomingCallWatcher, useMentionsUnread без messenger-api, прямые импорты кита в AppShell/messenger-ui, optimizePackageImports+=@superapp/shared), full-reload киллеры (StatTile/сетки/window.location→Link/router.push), person-skins notify per-userId, usePopover rAF+Esc-capture, кит-баги (popover z 200→320 ПОД модалкой, ui-menu-sep display:block, ConfirmDialog красная сплошная, scrollbar-gutter:stable, TickBar clip-path, шиммер transform, блюр на ::before, ModalShell фокус/role на подложке, транзишены каркаса сняты). Итог: холодный роут 0.4–1.7с, тёплый 100–300мс.

## Волна 2 — все 5 пунктов бэклога (tsc чист, браузер живьём, консоль 0)
1. **memo ростеров**: PersonCard/PersonChip/StaffPersonCard в memo; members/page — useMemo-карты cardProps/actions поверх writeToRef; circles/page — cardHandlers/myCoinsBy поверх cardActionsRef (стабильные колбэки зовут СВЕЖИЕ замыкания через ref — activeGroup не протухает). Паттерн: перед memo стабилизируй ВСЕ пропсы, инлайн-объекты/стрелки убивают его молча.
2. **RQ-кэш**: SkinsSection (cardSkins* ключи + ОБЩИЙ circlesKey), профильный WalletSection (wallet* + currencyBadgeKey), кошелёк орг. (companyWalletKey/companyHoldersKey + ОБЩИЙ workspaceMembersKey), shop/page (shopMineKey/shopOfKey(owner)/shopListingsKey(showcase)/shopAccessibleKey + contactsKey; loadShop/reload сохранили ИМЕНА, стали invalidate — call-sites модалок не тронуты). Все ключи в lib/queries.ts.
3. **Поллинг процессов**: журнал 5с всегда → `(q)=> q.state.data.some(running) ? 7000 : 30000` (паттерн офиса).
4. **A11y кита**: Menu — roving-фокус (эффект active→focus, открытие→первый пункт через setTimeout(0) на портал; Enter/Space нативные — свой Enter-хендлер УДАЛЁН, иначе двоил бы; Tab закрывает; Fragment вместо span-обёрток; role=separator); Select — useId (label→триггер→listbox→activedescendant, option ids), kbdNav-ref: scrollIntoView только после клавиатуры (иначе mouseenter-скролл-дрожание); Field.descId → aria-describedby (Input/Textarea/Select/DatePicker/Toggle); DatePicker — крестик ВНЕ триггера (вложенный интерактив невалиден, Firefox не фокусировал), aria-pressed вместо grid/aria-selected — ⚠️ CSS-селектор .ui-cal-day обновлён вместе; Tabs — стрелки переносят DOM-фокус (data-key + CSS.escape) + Home/End; SegmentedControl + ContextSwitcher — role=group + aria-pressed (CSS матчит оба атрибута); Modal — aria-labelledby через useId.
5. **Плотность**: `--control-py` (0.625rem/0.375rem) + `--control-h` в .ui-btn--md/.ui-input/.ui-select-trigger/.input; дефолт не изменился (фактически 42px — min-height 38 не был binding), compact 34px.

## Ловушки
- Консоль браузера копит HMR-ошибки на вкладку → проверять в НОВОЙ вкладке.
- next.config.ts требует рестарта dev-сервера; launch.json зовёт next напрямую (мимо npm-скрипта) — менять в ОБОИХ местах.
- optimizePackageImports покрывает сабпуть /ssr (проверено: 241 модуль, не 1513) — «phosphor-барабан» ложный след.
- Синтетический Esc/клик в тестах диспатчить на document.activeElement (React слушает на корне, событие с document не доходит).

## Бэклог (после двух волн)
WorkspacesPanel дублирует ['workspaces']+fetchProfile на маунт; isLoading-гейты→placeholderData за пределами 4 конвертированных страниц; @xyflow→dynamic в страницах процессов; LottieEffect IO-синглтон; Tabs tabpanel-связка (call-sites); дубли .btn-*/.input; SVG-спрайт иконок (1.87МБ/dev-чанк); виртуализация истории чата.
