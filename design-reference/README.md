# Handoff: SuperApp — редизайн (Organic Bento, warm matte)

## Overview
Редизайн SuperApp: тёплый «бумажный» фон, чистые светлые блоки-бенто, тонкие контурные иконки вместо Material Symbols, матовые полупрозрачные чипы и штриховые (tick) прогресс-индикаторы. 3 экрана: Dashboard, Projects, Risk Survey (плейграунд компонентов) + сайдбар с деревом подразделов.

## About the Design Files
Файлы в этом пакете — **дизайн-референсы, сделанные в HTML** (`SuperApp Redesign.dc.html` + `support.js` — рантайм прототипа; открой .dc.html в браузере из одной папки с support.js). Это НЕ production-код. Задача: **воссоздать этот дизайн в существующем стеке целевого проекта** (React/Vue/и т.п.), используя его паттерны и библиотеки. Если стека ещё нет — выбери подходящий фреймворк и реализуй там.

## Fidelity
**High-fidelity.** Цвета, типографика, отступы, радиусы и состояния — финальные, воспроизводить точно.

## Design Tokens

### Цвета (зафиксированы пользователем — менять нельзя)
- Фон страницы: `#eae6de`
- Все блоки/карточки/сайдбар: `#fafbf8`

### Остальная палитра
- Текст основной: `#1d1b1d`; вторичный: `#6b655e`; приглушённый: `#8a8478`; подписи/labels: `#a39d92`
- Акцент (primary, действия): `#588cd3`; тёмный вариант для текста на матовом фоне: `#3f6aa8`
- Success: база `#74a277`, текст `#3c6842`
- Warning/hold: база `#d6966c`, текст `#9a5f2f`; иконки на персиковом: `#b06a38`
- Danger: база `#de6d68`, текст `#b04a45`
- Границы/линии: `#e2dccf` (бордеры), `#eee9dd` (разделители), `#ddd6c8` (линии дерева, пустые тики), `#e4ded1` (пустые тики на белом)
- Активная подложка (nav pill): `#ece7dc`; hover-подложка: `#f1ede3`; лёгкая подсветка пути: `#f1ede3`
- Середина градиентов: `#d6a04c`

### Матовые чипы/элементы (правило)
Заливка = rgba(база, 0.12–0.16), бордер 1px = rgba(база, 0.30–0.35), текст = тёмный вариант цвета. Примеры:
- Синий: bg `rgba(88,140,211,0.12)`, border `rgba(88,140,211,0.3)`, текст `#3f6aa8`
- Зелёный: bg `rgba(116,162,119,0.14)`, border `rgba(116,162,119,0.32)`, текст `#3c6842`
- Персик: bg `rgba(214,150,108,0.16)`, border `rgba(214,150,108,0.35)`, текст `#9a5f2f`
- Красный: bg `rgba(222,109,104,0.14)`, border `rgba(222,109,104,0.32)`, текст `#b04a45`

### Типографика
Шрифт: **Manrope** (Google Fonts, 400–800), везде.
- H2 экрана: 26px / 800 / letter-spacing -0.02em
- Заголовок карточки: 18px / 800 / -0.01em
- Заголовок элемента: 15px / 700; крупная цифра: 30px / 800 / -0.02em
- Текст: 13–14px / 500, line-height ~1.55, цвет `#6b655e`
- Label (капс): 10px / 700 / letter-spacing 0.08em / uppercase / `#a39d92`
- Мета: 11px / 600 / 0.03em

### Иконки
**Phosphor Icons, weight Light** (тонкий штрих ~1.5px). Нав: 20px; в карточках 16–22px. Material Symbols не использовать.

### Радиусы и тени
- Карточки-бенто: 24px (мелкие карточки 20px); кнопки: 12px; nav-пилюли: 14px; чипы/пилюли/аватары: 999px; мелкие кнопки-иконки: 8–10px
- Тень карточек: `0 4px 20px rgba(0,0,0,0.04)`. Сайдбар: та же тень, внешние края прямые (флаш к краю экрана)
- Сетка: 12 колонок, gap 16px; внешние поля 24–28px; max-width контента 1120px

### Штриховой (tick) прогресс-бар — фирменный паттерн
Вертикальные штрихи 2px с шагом 5px. Реализация (CSS):
```css
/* контейнер: height 8–16px; border-radius 2px; overflow hidden */
/* пустые тики */  background: repeating-linear-gradient(90deg, #ddd6c8 0 2px, transparent 2px 5px);
/* заливка: абсолютный слой width:N% */ background: repeating-linear-gradient(90deg, #588cd3 0 2px, transparent 2px 5px);
```
Градиентный вариант (2 шт: зелёный→красный `#74a277 → #d6a04c → #de6d68` и красный→зелёный) — 3 слоя:
1) градиент на всю ширину; 2) поверх маска промежутков `repeating-linear-gradient(90deg, transparent 0 2px, #fafbf8 2px 5px)`; 3) «крышка» непройденной части от N% до 100%: `repeating-linear-gradient(90deg, #e4ded1 0 2px, #fafbf8 2px 5px)`.
Загрузка файла в Drag&Drop использует градиент красный→зелёный.

## Screens / Views

### 1. Сайдбар (общий)
264px, `#fafbf8`, прямые края, вертикальный скролл при нехватке высоты.
- Лого: квадрат 40px r12 `#588cd3`, буква «S» белая 800; рядом «SuperApp» 17/800 + «WORKSPACE» label
- Пункты: Dashboard (ph-house), Inbox (ph-chat-circle), Projects (ph-squares-four, с шевроном-каретом, вращается при сворачивании), Calendar (ph-calendar-blank); внизу кнопка «Connected apps» (бордер `#e2dccf`, иконка ph-circles-three-plus синяя, карет справа), разделитель, Settings (ph-gear), Support (ph-question)
- Пункт: padding 11px 14px, r14, 14/600; активный: bg `#ece7dc`, текст `#1d1b1d`; неактивный `#5d574e`; hover `#f1ede3`
- **Дерево под Projects** (сворачивается кликом по Projects): Survey Data (ph-file-text) → Valuation Survey, Risk Survey (ph-calendar-blank); Financial Data (ph-table) → Financial Performance (ph-globe), Financial Standards (ph-scales). Уровень 1 — 13/600 `#5d574e`; уровень 2 — 13/500 `#8a8478`
- Линии-ветки: 1px `#ddd6c8`, **скруглённые колена**: элемент 14px шириной с `border-left + border-bottom + border-bottom-left-radius:10px`, вертикаль сверху до центра строки, горизонталь к иконке; вертикальные «стволы» продолжаются между строками. Отступы: уровень1 line x=0/текст 22px; уровень2 line x=22/текст 44px
- **Подсветка пути** (когда открыт Risk Survey): Projects — bg `#f1ede3`; Survey Data — текст/иконка `#1d1b1d`; линии колен пути — `#b3a98f`; Risk Survey — пилюля bg `#ece7dc`, текст `#1d1b1d` (неактивный: `#8a8478`)

### 2. Топбар (общий)
- Слева сегмент-контрол (Overview | Analytics): трек rgba(29,27,29,0.06) r999 p3; активный сегмент `#fafbf8`, 12/800, тень `0 1px 4px rgba(0,0,0,0.08)`
- Справа: поиск-пилюля (240px, bg `#fafbf8`, бордер `#e2dccf`, иконка ph-magnifying-glass; focus: бордер `#588cd3` + ring `0 0 0 3px rgba(88,140,211,0.15)`), кнопки-иконки 38px (ph-plus, ph-bell с красной точкой `#de6d68`), аватар 36px

### 3. Dashboard
Сетка 12: карточка проекта (span 8) + правая колонка (span 4) + Recent Services (span 12, 3 колонки).
- Карточка проекта: H2 «Q4 Platform Redesign», «Client: Acme Corp», чип «Active» (зелёный матовый, иконка ph-check-circle), описание, label PROGRESS + «75%» (`#3f6aa8`), tick-бар 16px синий 75%, разделитель, стек аватаров 32px (border 2px `#fafbf8`, нахлёст -10px, «+2» на `#ece7dc`) и кнопка «View Details» (синяя матовая)
- Monthly Revenue: label + круг 34px матовый синий (ph-coins), «$42,850» 30/800, тренд «+14.5% vs last month» зелёный (ph-trend-up)
- Погода: круг 46px матовый персик (ph-sun `#b06a38`), «San Francisco», «72°F · Sunny»
- Server Load High: квадрат 34px r12 матовый красный (ph-warning-circle), текст, tick-бар 12px красный 92%, подписи «92% LOAD» / «CLUSTER A»
- Recent Services: карточки r20 (иконка 44px r14 матовая + название 15/700 + статус + время label): Database Sync (ph-database, синий), Security Audit (ph-shield-check, зелёный), API Gateway (ph-plugs, персик). Hover: translateY(-2px)

### 4. Projects
Заголовок «Projects Overview» + кнопка «Add Task» (solid `#588cd3`, белый текст, r12, тень `0 4px 14px rgba(88,140,211,0.3)`, иконка ph-plus).
- All Tasks (span 4): строки «иконка + цветной лейбл + счётчик» — In Progress (ph-arrows-clockwise, синий, 24), On Hold (ph-pause-circle, персик, 12), Completed (ph-check, зелёный, 156); Deleted (ph-trash, красный, 8) прижат вниз за разделителем. Счётчики 16/800 тёмные; hover строки rgba(29,27,29,0.04)
- Recent Activity (span 8): заголовок + 2 кнопки-иконки (ph-funnel, ph-dots-three, 36px r12 бордер); карточки задач r20: чекбокс 18px (accent `#588cd3`), заголовок 15/700, матовый чип статуса с иконкой, описание, мета (ph-calendar-blank дата, ph-chat-circle комментарии), аватары 26px. Выполненная задача: opacity 0.65 + line-through + чекбокс отмечен

### 5. Risk Survey (плейграунд компонентов)
Хлебная крошка «PROJECTS / SURVEY DATA» label, H2 «Risk Survey», чип «UI Kit Preview» (синий матовый, ph-cube). Сетка 12, ряды: 4+4+4, 5+4+3, 6+6.
- **Date Picker** (4): шапка «July 2026» + кнопки-стрелки 26px; ряд MO–SU 9px caps; дни — грид 7 колонок, кнопки высотой 32px r999 (padding:0; min-width:0 — иначе грид переполняется); выбранный: solid `#588cd3` белый; «сегодня» (26): бордер `rgba(88,140,211,0.5)`, текст `#3f6aa8`. Июль 2026 начинается со среды (offset 2 при неделе с Пн), 31 день
- **Gradient Progress** (4): два tick-бара 14px: «RISK EXPOSURE 68%» зелёный→красный (label красный) и «MITIGATION COVERAGE 82%» красный→зелёный (label зелёный) + подписи
- **Alerts** (4): 3 матовых алерта (success ph-check-circle / warning ph-warning / danger ph-warning-circle), 12/600, крестик ph-x закрывает; кнопка reset (ph-arrow-counter-clockwise) возвращает все
- **Drag & Drop** (5): зона `border:2px dashed #ddd6c8` r16; при dragover бордер `#588cd3` + bg `rgba(88,140,211,0.06)`; иконка ph-upload-simple в матовом персиковом квадрате, «Drag and drop or browse files» (browse — синяя ссылка), «MAX FILE SIZE: 20 MB» label. Ниже строки файлов r14 бордер `#eee9dd`: завершённый (матовый зелёный ph-file-text, «4 MB · COMPLETE» зелёным, ph-trash) и загружающийся («survey-data.fig», 75%, tick-бар 8px с градиентом красный→зелёный, ph-x)
- **Text Scramble** (4): заголовок 20/800 собирается из случайных глифов (`!<>-_/[]{}=+*^?#`), раскрытие ~3 кадра/символ с интервалом 40ms, фразы циклом каждые ~2.6s: «Risk Survey 2026», «Text Scramble FX», «SuperApp Modules»; кнопка replay (ph-arrow-clockwise)
- **Slider** (3): значение 24/800 `#3f6aa8`, tick-бар-превью 10px синий, нативный range (accent-color `#588cd3`)
- **Pagination** (6): кнопки 34px r10: стрелки (бордер), страницы 1–6 — активная матовая синяя; справа «Page X of 6»; flex-wrap на узких ширинах
- **Project Settings** (6): 3 строки «название 13/700 + описание 11/500» и тумблер 44×26 r999: **ON = `#74a277` (зелёный)**, OFF = `#ddd6c8`, кноб 20px белый, translateX(18px), transition 0.2s

## Interactions & Behavior
- Навигация: клики в сайдбаре переключают экраны; Projects повторным кликом сворачивает/разворачивает дерево (карет rotate 180°); Risk Survey открывается из дерева
- Inbox/Calendar/Settings/Support — заглушка-empty state (карточка, ph-tray в сером круге, заголовок раздела)
- Hover: подложки `#f1ede3`/rgba(29,27,29,0.04–0.06); карточки сервисов приподнимаются; transitions 0.15–0.2s ease
- Drag&Drop: dragover/dragleave/drop меняют бордер/фон зоны (см. выше)

## State Management
`view` ('dashboard'|'projects'|'risk'|...), `treeOpen` (bool), `selectedDay` (число, дефолт 14), `page` (1–6, дефолт 2), `slider` (0–100, дефолт 40), тумблеры `{alerts:true, scale:false, tfa:true}`, видимость алертов `{s,w,d}`, `drag` (bool), текст скрэмбла (интервал живёт только на экране risk, чистится при unmount).

## Assets
- Шрифт: Manrope (Google Fonts)
- Иконки: @phosphor-icons (weight Light) — в React использовать `@phosphor-icons/react` с `weight="light"`
- Аватары: временные фото-заглушки (googleusercontent) — заменить на реальные из проекта

## Files
- `SuperApp Redesign.dc.html` — прототип всех 3 экранов (разметка внутри `<x-dc>`, логика в `<script data-dc-script>`)
- `support.js` — рантайм прототипа (нужен только чтобы открыть .dc.html локально; в целевой проект не переносить)
