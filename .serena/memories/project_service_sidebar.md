# ServiceShell — платформенный левый сайдбар сервисов (веб)

**Построен 2026-07-03** (гриль → бенчмарк-ресёрч → стройка → браузерная проверка). Первый потребитель — «Финансы»; второй — **«Задачи» (2026-07-04)**. Все будущие сервисы обязаны использовать этот каркас (строка в карте переиспользования CLAUDE.md + шаг 6 плейбука).

## Бейджи-счётчики пунктов (построены 2026-07-04, первый потребитель — Задачи)
- `ServiceNavItem.badge?: number | string` — билдер передаёт число только когда > 0 (0/undefined не рендерится; хелпер `navBadge()` в service-nav.ts).
- Рендер: `NavBadge` в ServiceShell.tsx — пилюля `.svc-badge` в развёрнутом списке (лист + parent-link), drawer (тот же NavTreeItem) и флайауте рейла (`RailFlyout.badge` + дети); в самом рейле — карандашная точка `.svc-badge-dot` на иконке («внутри есть работа», Slack-модель).
- CSS в globals.css рядом с `.svc-label`: пилюля margin-left:auto, surface-container, secondary, нерегулярный радиус, rotate(-1deg); точка — восковой градиент primary.
- Живость: бейджи приходят из контекста шелла сервиса (у Задач — `GET /tasks/stats` на RQ-ключе под корнем `['tasks']` + refetchInterval 60s) — мутация инвалидирует корень, бейджи обновляются без F5.

## Решения продукта (гриль с Санжаром)
1. **Двухуровневая навигация (модель Salesforce/Stripe):** верхняя полоска ОСТАЁТСЯ и в будущем станет глобальной навигацией всего SuperApp6; у каждого сервиса — свой левый сайдбар с разделами. НЕ полный shell в стиле Notion (вариант отвергнут пользователем).
2. **Разделы = отдельные URL** под layout'ом сервиса (как /profile/[section]).
3. **«Обзор» — новая главная финансов** (/finance): итоги месяца (на счетах/расходы/доходы), лимиты с прогрессом, ближайшие платежи (долги dueDay + повторы), последние операции. Собран из существующих запросов, новых API нет.
4. **Переключатель книг + «Доступ» (🔑) — в шапке сайдбара** (паттерн workspace-switcher Notion/Slack). Бейдж «только просмотр» там же.
5. **Tree lines как на референсе** (запрос пользователя 2-м сообщением): вложенные пункты — с ветками-локтями, родители — с шевроном-дисклоужером.

## Архитектура
- `apps/web/src/lib/service-nav.ts` — типы (`ServiceNavConfig/Group/Item`), константа cookie `SIDEBAR_COOKIE='sa6_sidebar'`, билдер `buildFinanceNav(ctx)`, центральный реестр `SERVICE_NAV` (паттерн entities.ts). Item: `{key,label,icon(эмодзи),href,exact?,children?}` — максимум 2 уровня (правило NN/g/GitLab). `preserveParams` — query-параметры, переносимые между разделами (у финансов `['book']`).
- `apps/web/src/components/shell/ServiceShell.tsx` ('use client') — весь каркас: topbar (glassmorphism, «← SuperApp6 · <Сервис>», бургер <768px) + сайдбар + main. Использует useSearchParams → **layout сервиса ОБЯЗАН оборачивать в `<Suspense>`**. Внутри: `renderRailItem` (рейл) + модульный компонент `NavTreeItem` (развёрнутый/drawer; хуки на пункт).
- CSS: блок `.svc-*` в `globals.css` (Digital Atelier: сайдбар = лист surface-container-low, БЕЗ линий-бордеров, тень тонированная; активный пункт = белая карточка + восковой «мазок» ::before слева, radius-sketch).

## Вложенность (2-й уровень) — механика построена и проверена в браузере
- **Развёрнутый вид:** родитель = ряд `svc-parent` (ссылка `svc-parent-link` навигирует + отдельная кнопка `svc-chevron` c aria-expanded — W3C-модель «родитель-ссылка → раскрытие отдельной кнопкой»); открыт по умолчанию; раздел с активным ребёнком раскрывается сам; активен ТОЛЬКО сам пункт (родитель не подсвечивается, когда активен ребёнок — как на референсе).
- **Ветки-линии:** каждый ребёнок в обёртке `.svc-branch`: ::before = локоть (вертикаль + скруглённый поворот border-bottom-left-radius), ::after = продолжение ствола до следующего (у последнего обрывается). Цвет rgba(122,122,110,0.28), 2px — карандашно-мягкий. Обёртка нужна, потому что ::before самого пункта занят восковым мазком active.
- **Рейл:** клик по родителю НЕ навигирует — открывает флайаут (модель Jira/ADS, preventDefault), листья навигируют. Флайаут родителя = панель с ЗАГОЛОВКОМ-СЕКЦИЕЙ (uppercase, `.svc-flyout-label.group`) + дети с теми же ветками — 1в1 средний вариант референса. Клик мимо закрывает (document pointerdown-листенер).
- У финансов вложенности пока НЕТ (все 9 пунктов плоские — no-placeholder-UI правило); механика включится сама у первого сервиса с children (кандидаты: Организация — Сотрудники→Должности/Отделы/Филиалы; будущие Отчёты финансов).

## Поведение (бенчмарк-консенсус NN/g/shadcn/Jira/GitLab/Baymard)
- Ширины: развёрнут **260px** ↔ рейл **60px** (CSS-переменные `--svc-w-*`; транзишн width/margin 250мс разворот / 200мс сворачивание, easing cubic-bezier(0.2,0,0,1)).
- **Cookie-персистенция**: сервер-layout читает `sa6_sidebar` через `cookies()` (await, Next 15) → `defaultCollapsed` → первый рендер без «прыжка» (модель shadcn).
- **Ctrl/Cmd+B** — toggle (игнорирует ввод в input/textarea/select/contentEditable); Esc закрывает drawer/флайаут.
- Брейкпоинты: ≥1200 — выбор пользователя; 768–1199 — авто-рейл (выбор возвращается на десктопе, ref userChoice); <768 — сайдбар скрыт, бургер → **drawer 288px поверх всего** (подложка+blur, скролл-лок body, Esc/подложка/переход закрывают, фокус на первый пункт при открытии и назад на бургер при закрытии).
- **Рейл**: только иконки; ховер (пауза 350мс, грейс закрытия 500мс — тайминги NN/g/Baymard), фокус и клик (родители) → **флайаут** — бумажный чип `position:fixed` справа (не клипается overflow'ом). Иконка сервиса вверху рейла = развернуть.
- A11y: `<aside aria-label>`, `aria-current="page"`, aria-expanded на шевронах, aria-haspopup на рейл-родителях, focus-visible контур, disclosure-модель (НЕ role=tree), `prefers-reduced-motion` гасит транзишены.
- ВАЖНО (грабли автотестов): (1) синтетический `dispatchEvent(new MouseEvent('mouseenter'))` НЕ триггерит React onMouseEnter; (2) `element.focus()` в НЕсфокусированном окне Chrome не стреляет focusin → React onFocus молчит — проверять флайаут КЛИКОМ по родителю или фокусом при активном окне.

## Финансы на каркасе
- `app/finance/layout.tsx` — **server component**: `await cookies()` → `<Suspense><FinanceShell defaultCollapsed>…`.
- `app/finance/finance-shell.tsx` — контекст `useFinanceBook()`: `{bookId(?book= из URL — шарится/переживает F5), isOwnBook, canEdit, meId/meName, overview, accounts(активные), categories, people, invalidate, withBook(href, extra?)}`; общие запросы overview/people/sharedBooks; `switchBook` (с /finance/coins при уходе в чужую книгу уводит на /finance); headerSlot = `FinanceBookCard` (дропдаун книг с PersonChip + 🔑 AccessModal, owner-only).
- Разделы: `/` Обзор (page.tsx переписан) · `/feed` (QuickEntry+TransactionFeed+чипы-фильтр счетов, `?account=` дип-линк со страницы Счета) · `/reports` (ReportView) · `/coins` (гейт isOwnBook, в чужой книге пункт скрыт+заглушка) · `/accounts` · `/categories` · `/people` · `/debts` · `/recurring`.
- Распил page.tsx (1156 строк) → `finance-feed.tsx` (QuickEntry/TransactionFeed/TransactionRow + **экспорт `txPresentation(tx, accountById)`** — общая презентация операции для ленты и Обзора), `finance-accounts.tsx` (AccountsPanel: управление + «операции →» в ленту; SUBTYPES/CURRENCIES), `finance-categories.tsx`, `finance-people.tsx`. `bookParams` переехал в `finance-lib.ts`. Старый `BookSwitcher` в finance-access.tsx больше не используется (заменён FinanceBookCard), `AccessModal` переиспользуется.
- Новый RQ-ключ `financeRecentTxKey` (queries.ts) — последние операции Обзора (отдельно от infinite-ключа ленты: разные формы кэша).
- Все внешние дип-линки вели на голый `/finance` (actionUrl уведомлений, rich-карты, слой календаря, плитка dashboard) — живы (это Обзор).

## Проверено в браузере (превью, tester1)
Развёрнутый/рейл/drawer, флайауты (клик по родителю: заголовок-секция + дети с ветками; leaf-подпись), дерево с шевроном (collapse/expand, авто-раскрытие активного), Ctrl+B, cookie expanded/collapsed, авто-рейл на 961px, все 9 разделов с активным пунктом, drawer закрывается по переходу, консоль 0 ошибок (историческая renderItem-ошибка — промежуточный HMR между правками, ушла после перезагрузки), web tsc зелёный. Вложенность проверялась ВРЕМЕННЫМ конфигом (Отчёты→Месяц/Динамика/По людям), затем откачена до плоской — no-placeholder-UI. `.claude/launch.json` дополнен конфигом `api`.

## Ревью-фиксы (8 углов ревью, 2026-07-03, все 8 находок исправлены)
1. **Смена книги = key-ремоунт разделов**: `<Ctx.Provider key={bookId ?? 'own'}>` в finance-shell — все локальные состояния страниц (фильтр по счёту, editingTx, формы) сбрасываются при смене книги (паритет со сбросами старого onSwitch; страница НЕ перемонтируется сама при смене query-параметра одного роута — это была причина багов).
2. **actionUrl `finance.book.shared` → `/finance?book=`** (finances.service.ts:1212; раньше `?bookId=` — параметр, который никто никогда не читал; теперь дип-линк открывает расшаренную книгу — проверено live).
3. **PersonChip в карточке книги** (шапка сайдбара): активная чужая книга = PersonChip S владельца, не голый текст (Принцип 2).
4. **BookSwitcher удалён** из finance-access.tsx (мёртвый дубль FinanceBookCard).
5. **finance-ui.tsx**: `budgetProgress()` + `<BudgetBar>` — одна точка правды порогов 80/100% для «Отчётов» (BudgetLine) и «Обзора».
6. **WEEKDAYS_SHORT** в finance-lib.ts (дубли в page.tsx и finance-debts.tsx убраны).
7. **SERVICE_NAV типизирован и реально используется**: `ServiceNavContexts` (map сервис→тип ctx) + `getServiceNav(service, ctx)` — FinanceShell резолвит через реестр; новый сервис = ключ в ServiceNavContexts + запись.
Проверено: web tsc, verify-finance ALL PASS, браузер (смена книги: фильтр сброшен, чипы новой книги, PersonChip «Диана» в шапке, 0 ошибок консоли за чистый прогон всех разделов + переключений).

## Дальше (не сделано)
- Миграция остальных сервисов на ServiceShell (кандидат №1 — организация: Главная/Сотрудники/Процессы/Профиль как разделы; также /profile). Пока сайдбар только у /finance.
- Бейджи-счётчики на пунктах (поле в конфиге можно добавить).
- Верхняя полоска — будущая глобальная навигация SuperApp6 (решение зафиксировано, не строилась).
