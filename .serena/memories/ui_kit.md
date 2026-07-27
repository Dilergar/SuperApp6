# UI-кит веба (`apps/web/src/components/ui/`)

Построен в волне 1 редизайна, 2026-07-27. **Единственный источник** кнопок, полей,
модалок, чипов и прочих примитивов. Полный каталог — раздел «Компоненты» в `DESIGN.md`,
живая витрина всех состояний — `/dev/ui` (только при NODE_ENV=development).

Импорт из корня кита: `import { Button, Modal, Chip } from '@/components/ui';`

## Состав
Icon / EmojiIcon · Button / IconButton · Field / Input / Textarea / SearchField · Select ·
Toggle / Checkbox · Chip / Badge / StatusDot · Card / CardHeader / BentoGrid / PageHeader /
StatTile / EmptyState / Divider · TickBar / GradientTickBar · Modal / ConfirmDialog · Menu ·
Tooltip · Tabs / SegmentedControl · Pagination · Calendar / DatePicker · Dropzone · Alert ·
Spinner / LoadingBlock / Skeleton / AvatarStack · usePopover · toneVars / cx.

Стили — `components/ui/ui.css` (подключён в `app/layout.tsx` после globals.css).
Состояния :hover/:focus-visible/:disabled/:checked живут ТАМ, а не в инлайне —
в инлайн-стилях псевдоклассов нет, из-за чего раньше ховеры подделывали
обработчиками onMouseEnter на каждой из 473 кнопок.

## Правило
Страницам запрещено рисовать свои примитивы. Не хватает — расширяется кит
(Принцип 1, как у платформенных движков бэкенда), а не заводится копия.

## Кит НЕ заменяет
- человека в UI → `PersonChip`/`PersonAvatar` (5 форм-факторов, продуктовое правило);
- выбор человека/Группы/отдела/должности/филиала → `EntitySelector`;
- файлы → `components/files/*`; звонки → `components/calls/*`;
  хроника → `components/chatter/*`; SMS-подтверждения → `components/verify/*`.

## Ловушки (легко нарушить по незнанию)
- Тумблер ВКЛ — ЗЕЛЁНЫЙ (`--success-base`), не акцентный: правило дизайн-пакета.
- Невыбранный чип-фильтр всегда нейтральный, иначе строка фильтров читается как статусы.
- `Select` не годится для людей и Групп — там обязательна карточка человека.
- Ячейкам сетки календаря нужны `padding:0; min-width:0`, иначе грид переполняет контейнер.
- `dragover` обязан звать `preventDefault()`, иначе `drop` не сработает.
- Даты сравниваются по ЛОКАЛЬНЫМ частям (год-месяц-день), не через UTC: пояс +05
  давал бы «сегодня» на день раньше.
- Выпадающие слои (Select, Menu, DatePicker, Tooltip) рендерятся порталом в `body` —
  иначе `overflow:hidden` родителя обрезает их в таблицах и панелях.
- Модалка фокусирует первое ПОЛЕ, а не первый фокусируемый элемент (иначе курсор
  встаёт на крестик «Закрыть»); при закрытии возвращает фокус на источник.
- `IconButton` — forwardRef: якорь нужен всплывающим слоям для позиционирования.
