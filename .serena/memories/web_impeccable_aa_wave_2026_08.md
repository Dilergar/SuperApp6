# Волна /impeccable 2026-08-01 (audit → adapt → harden → optimize → polish)

Полная цепочка по apps/web выполнена; НЕ закоммичено. Аудит: 14/20 (a11y 2/4, perf 3/4, responsive 2/4, theming 3/4, integrity 4/4).

## Что изменилось (несущее)

- **PRODUCT.md создан** (корень репо): маховик B2C↔B2B («ноль переключений»), успех = коммерческий продукт в КЗ, **WCAG AA = требование продукта**.
- **AA-палитра** (утверждена пользователем, отражена в DESIGN.md): `--muted`/`--label` → `#6b655e`; сплошные заливки ЗЕЛЁНОЙ/КРАСНОЙ/ПЕРСИКОВОЙ кнопок = тёмные пары (`--success`/`--danger`/`--warning`), ховеры `--*-hover` = color-mix к базе (warning 85%, waiting 88% — иначе белый <4.5); `--control-border #948e82` — рамка полей; спикеры Диктофона = 6 тёмных тонов (violet/teal официально расширены на эту роль).
- **ИСКЛЮЧЕНИЕ (решение пользователя тем же днём): СИНЯЯ кнопка и «мой» бабл чата ВОЗВРАЩЕНЫ на светлую базу `#588cd3` с белым** — тёмная пара «чересчур строгая». Осознанное отступление от AA (3.4:1), записано в PRODUCT.md и DESIGN.md — будущими ревью НЕ «чинить». Токен `--primary-hover` удалён (стал ничьим); accent solid = `--primary`, ховер = `--primary-dim`.
- **Мобильный веб**: `useIsMobile` (lib/hooks, 767 + resize-страховка); мессенджер одноколоночный с «← назад» (`onBack` у Conversation); планнер календаря на телефоне закрыт по умолчанию (`sa6_cal_panel`); топбар-контексты → меню; панель встречи — колонкой с toggle-вкладками; поля ≥16px (автозум iOS); 100dvh; `@media (pointer:coarse)` тач-мишени в ui.css.
- **Клавиатура/скринридер**: «⋯» сообщения всегда в DOM (`.msg-row`/`.msg-actions` CSS-видимость); aria композера; волна = настоящий слайдер; EntitySelector = ARIA-combobox; вложения — кнопки; тосты смонтированы постоянно.
- **Спрайт иконок**: `icons.manifest.json` → `pnpm --filter ./apps/web gen:icons` → `public/icons/sprite.<hash>.svg` (immutable-кэш); Icon.tsx рисует `<use>`; @phosphor-icons/react ушёл из рантайм-бандла (~60–80 КБ gzip/страницу). Новая иконка = манифест + перегенерация.
- **Чистка дрейфа**: hex8/`${color}55` → color-mix; tones.ts только var(); ~20 самодельных теней → `--shadow-card`/`--shadow-pop`; `#fff` → `--on-primary`; hex из shared удалён (мёртвые color-поля calendar.ts; рарности скинов → web `RARITY_COLORS` в app/circles/card-skin.ts).

## Ловушки (дорого переоткрывать)

- **CDP-эмуляция панели браузера** НЕ диспатчит resize/matchMedia-события при смене метрик и **морозит CSS-transitions при скрытой панели** (document.hidden): «opacity 0 после фокуса» и «isMobile не сработал» — артефакты замера. Проверять `dispatchEvent(new Event('resize'))` и точечным `transition: none`.
- @phosphor-icons/react сломан под `require()` (type:module + index.cjs.js → «exports is not defined») — в node-скриптах только `await import()`.
- Computed-цвета color-mix приходят форматом `color(srgb …)` — парсеры контраста обязаны понимать его, не только rgb().

## Осталось из аудита

Виртуализация истории чата — отдельная сессия (риск скролл-механики главного сервиса). fetchAllContacts закрыт как несущественный (страница = 100). Детектор impeccable по всему src: 5 ложных, 0 настоящих.
