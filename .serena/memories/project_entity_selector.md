# EntitySelector — единый движок выбора сущностей (2026-06-08)

Переиспользуемый компонент выбора ЛЮБОЙ сущности (человек, Группа, позже отдел/филиал/должность), вместо россыпи нативных `<select>`. Построен по замечанию Sanzhar: «неправильно искать каждый select и переделывать отдельно» + нужно выбирать и целые Группы/отделы. Бенчмарк: Bitrix `UI.EntitySelector` (виджет + data-providers + TagItem с аватаром), Salesforce record-picker + pill+avatar. Никто не юзает нативный `<select>` для сущностей.

## Архитектура (3 файла)
- `apps/web/src/lib/entities.ts` — данные/реестр. `Principal{type,id}` (= принципал `core/access`: user|circle|department|position|branch|...), `EntityOption`, `loadEntities(type)` с пер-тип кэшем (провайдеры: user→`/contacts` пагинированно, circle→`/circles`), `invalidateEntities(type?)`, `ENTITY_TYPE_LABELS`. Новый тип = +1 лоадер.
- `apps/web/src/app/circles/EntityChip.tsx` — `GroupChip` (чип группы/отдела, без скина, размеры из `SIZE_CONFIG` PersonCard) + `EntityChip({entity,size})` диспетчер: user→`PersonChip` (скины!), circle/прочее→`GroupChip`.
- `apps/web/src/components/EntitySelector.tsx` — кастом-комбобокс (НЕ нативный select; в `<option>` карту не вставить). Поле = выбранные чипы (EntityChip S) + ×-удаление + поиск-инпут; дропдаун = сгруппировано по типам (Люди/Группы), строки = EntityChip M; клавиатура (↑↓/Enter/Esc/Backspace), клик-вне-закрытие; `multi` (+смешанные типы) | single. `onChange(Principal[])`.

## API
`<EntitySelector value={Principal[]} onChange={(p)=>...} types={['user','circle']} multi placeholder=... />`. Single → value длины 1.

## Применение
Первое реальное место — Shop шеринг: `SharePanel` (витрина) + `WishSharePanel` (вишлист) в `apps/web/src/app/shop/page.tsx` — две секции «Группы+Люди» заменены ОДНИМ EntitySelector → выбор человека И целой Группы в одном поле. onChange диффит со `shares` и зовёт существующий `toggle(type,id)` (POST/DELETE share). Браузер-проверено (Люди=карты M со скином, Группы=GroupChip, выбор→чип S, 0 ошибок), web tsc чист.

## Осталось мигрировать (механически, тот же компонент)
Задачи-пикер (`tasks/page.tsx` PeoplePicker — можно объединить «Человеку/Группе»), messenger `ContactPicker`/NewChat/добавление в группу, @-дропдаун упоминаний, Calendar shares (`calendar/social.tsx`), Dashboard invites, Workspaces wallet выбор сотрудника, валютные `<select>` (дженерик-тип 'currency' с CurrencyChip). 

## Связь с другими движками
- Output = принципал → `core/access` его уже понимает (см. `mem:project_access_layer_design`).
- Рендер человека = `PersonChip`/`PersonAvatar` (5 размеров+скины) — см. `mem:project_card_skins`. Принцип продукта: человек/сущность = карта ВЕЗДЕ (ради видимости платных скинов), не голый текст.

Статус: построено + браузер-проверено, НЕ закоммичено (рабочее дерево). Windows→PowerShell; API tsc только `nest build`.
