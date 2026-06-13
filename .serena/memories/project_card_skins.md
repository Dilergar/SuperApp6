# Card Skins — платформенная косметика для PersonCard (2026-06-07)

Продаваемые платформой скины карточки человека. Цель — монетизация (ориентир: Fortnite/Discord/Telegram Gifts). Дизайн зафиксирован грилл-сессией.

## Модель (скин = ДАННЫЕ, не код)
- Prisma: `CardSkin` (tokens JSON, rarity, priceAmount BigInt, supply/minted, availableFrom/Until, decor, frameUrl/backgroundUrl/effectUrl, authorId, schemaVersion, status) + `CardSkinInstance` (skinId, ownerId, serial — только у лимиток, acquiredVia) + `CardSkinTransfer` (история передач под будущий трейд). Equip-поля: `User.defaultSkinInstanceId`, `User.premiumUntil`, `Circle.equippedSkinInstanceId` (plain String?, валидация в сервисе).
- 6 тиров (common→mythic), редкость = только дефицит/престиж/цена (НЕ влияет на возможности), видна только в XL.
- Покупка через WalletModule Ledger: платформенная Currency `issuerType='platform'/issuerId='platform'` (лениво), mint (тест-topup) + transfer покупатель→system-счёт (Σ=0), оверселл-безопасный резерв (`UPDATE ... WHERE minted<supply RETURNING`). Эскроу/трейд — позже.

## Бэкенд
`apps/api/src/modules/card-skins/` (service+controller+module, импортит WalletModule). Эндпоинты `/api/card-skins/`: catalog, wallet, wallet/topup, :skinId/buy, inventory, equip (GET), equip/default, equip/group (премиум), resolve?userIds=. Резолвер скина для зрителя зеркалит резолв видимости Окружения: группы зрителя у владельца → выигрывает min(sortOrder) с equipped (премиум-гейт), иначе дефолт. Shared: `packages/shared/src/{types,validation,constants}/card-skin.ts`. Сиды: `scripts/seed-card-skins.cjs` (3 скина: Цветочный/Мятая бумага/Ретро-неон + effectUrl). Проверка: `scripts/verify-cardskins.cjs` (23/0). Демо: `scripts/demo-equip-skin.cjs`.

## Фронт — переиспользуемый движок «человек со скином»
- `apps/web/src/lib/person-skins.ts`: `usePersonSkin(userId)`/`usePersonSkins(ids)` — батч-за-тик + module-cache + `invalidatePersonSkins()` (после equip). Дёргает `/card-skins/resolve`.
- `apps/web/src/app/messenger/messenger-ui.tsx`: общий `Avatar` стал скин-зависимым; `PersonAvatar({userId,name,avatar,size})` = голый скин-аватар (userId опционален → фолбэк на инициал). ПРАВИЛО: любой «человек» в UI → `<PersonAvatar userId/>` или `<PersonChip size userId/>`.
- `apps/web/src/app/circles/card-skin.ts`: типы из @superapp/shared + DEFAULT_SKIN + **SIZE_CONFIG (5 размеров)** + CARD_SIZES + displayName.
- `apps/web/src/app/circles/PersonCard.tsx`: токенизирован, CardShell (слои bg/рамка/эффект; строчные размеры → inline-flex, не растягиваются) + CardBody (по размеру). `PersonChip({size,userId,firstName,lastName,role,bio})` — готовая карточка-строка со скином. `LottieEffect` (lottie-react) + `SkinEffect` (CSS-пресеты).
- `apps/web/src/app/profile/SkinsSection.tsx`: магазин/инвентарь/надевание/группы/превью.

## 5 размеров (XS/S/M/L/XL)
- XS = голый аватар 16px (вдвое меньше), без имени/анимации — тесные места (календарь).
- S = аватар+имя в строку → инлайн-упоминания, строки приглашений/держателей.
- M = аватар+имя+роль в строку → пикеры выбора человека (опции EntitySelector), ростер сотрудников.
- L = Имя Фамилия + «О себе»(если видно) + роль → грид Окружения (ровно для 100+), клик→XL.
- XL = всё подробно + редкость → профиль/разворот.
- Анимация: Lottie только XL/L (effect 'full'); лёгкая CSS в M/S ('subtle'); XS 'none'. (Анимацию в M/S вернули по требованию пользователя — раньше были static.)
- Ассеты Lottie: `apps/web/public/skins/{petals,neon,sparkle}.json`, генератор `apps/web/scripts/gen-lottie-skins.cjs`.

## EntitySelector — единый движок ВЫБОРА людей/сущностей (2026-06-07)
Требование продукта: «человек ВЕЗДЕ = одна из 5 карт, НЕ голый текст» (чтобы платные скины были видны). Нативный `<select>` карту внутрь не вставит → построен кастом-комбобокс. Ориентир: Bitrix `UI.EntitySelector` / Salesforce lookup.
- `apps/web/src/lib/entities.ts`: `Principal{type,id}`, `EntityOption{type,id,title,firstName?,lastName?,role?,icon?,color?,count?}`, `loadEntities(type)` (user→/contacts, circle→/circles, кэш), `invalidateEntities`, ENTITY_TYPE_LABELS. Типы-принципалы как в core/access: user|circle|workspace_role|department|position|branch|public (пока зарегистрированы user+circle; dept/position/branch — регистрацией позже).
- `apps/web/src/app/circles/EntityChip.tsx`: `GroupChip` (карточка Группы, без скина) + `EntityChip` (диспетчер: user→`PersonChip`, иначе→`GroupChip`).
- `apps/web/src/components/EntitySelector.tsx`: кастом-комбобокс (НЕ нативный select). Props: `value:Principal[]`, `onChange`, `types=['user']`, `multi=true`, `placeholder`, **`options?:EntityOption[]`** (свой датасет; иначе грузит сам). Поле = S-чипы выбранных + ×; дропдаун IN-FLOW (marginTop:4, НЕ absolute — иначе обрезается в модалках), опции — M-карточки в flex-wrap (2/ряд); клавиатура (стрелки/Enter/Esc/Backspace). Мульти + смешанные типы (люди+Группы в одном поле, «выбрать всю Группу»).

## Подключено везде (через PersonAvatar/PersonChip/EntitySelector)
**ПИКЕРЫ → EntitySelector:** Задачи (Исполнитель/Соисполнители/Наблюдатели/Группа — `tasks/page.tsx`, PeoplePicker УДАЛЁН); Календарь (`EventModal` InvitePicker = люди+Группы; `social.tsx` SharePanel single + SmartMatch multi; `resources-ui.tsx` доступ к брони = люди+Группы в одном поле); мессенджер (`ContactPicker.tsx` — тонкий адаптер над EntitySelector для DM/@-пикера; **создание группы (`NewChatModal`) и добавление участников (`GroupManageModal`) — EntitySelector `['user','circle']`: выбор Группы разворачивается в участников snapshot'ом через `myCircleIds` (минус уже состоящие), без лишних запросов**; B2B отдел/должность/филиал — после регистрации их loader'ов в `entities.ts`); Shop (`page.tsx` SharePanel/WishSharePanel люди+Группы, StaffPanel single); Workspaces (`wallet/page.tsx` выплата сотруднику single).
**ОТОБРАЖЕНИЯ → PersonChip/PersonAvatar:** грид Окружения (L→XL), профиль-превью (переключатель 5), мессенджер (списки/шапка/участники/поиск), упоминания (лента+инлайн S), ростер сотрудников (`members/page.tsx` M), держатели валюты компании (`wallet/page.tsx` S), строка покупателя заказа (`shop/page.tsx` S), приглашения Dashboard (`WorkspacesPanel.tsx` S) + Окружения (`circles/page.tsx` PersonAvatar — локальный `Avatar` удалён, InvitationCard получил `theirUserId`).
**Остаются нативными `<select>`** (вне scope «человек/группа/отдел/должность»): enum (статус/тип/повтор/напоминание/роль-воркспейса), валюты (отдельный тип `currency` — позже), ресурс/витрина/скин-инстанс, навигационные переключатели «чей магазин/вишлист смотрю» (`viewOwnerId`/`viewing` — там опция «Мой» не принципал; компактный switcher = паттерн гигантов).

## Прочее
- НЕ в chokepoint (личная косметика). authorId скрыт в UI (ручной, коллабы).
- Migration gotcha: `prisma migrate dev` подмешивает чужой дрейф search_documents (generated column `search_vector` + GIN trgm + chats index → P3018). Лечение: вручную вычистить migration.sql → `migrate resolve --rolled-back` → `migrate deploy`. (Уже отдельно зафиксировано в `mem:prisma_fts_migration_drift`.)
- WARNING: НЕ запускать полный `tsc --noEmit` на API (OOM) — `nest build`. Windows → PowerShell. Web `tsc --noEmit` безопасен и зелёный после всей миграции.
## Хардненинг по ревью (2026-06-07) — сделано всё, КРОМЕ F2 и F6 (отложены пользователем)
Полное ревью движка скинов + покрытия «человек=карточка» тремя агентами → 18 находок, пофикшены 16:
- F1 `invalidatePersonSkins` теперь ре-фетчит активные id (ref-счётчик `active`) — скин обновляется на месте, не слетает на дефолт до перезагрузки.
- F3 6 мест с голым текстом человека → `PersonChip size=S`: список задач (исполнитель), карточка задачи (Постановщик `creatorId` + Наблюдатели `observers[].userId`), организатор события (`occ.ownerId`), заявка на бронь (`ResourceBooking.bookerId`), оверлей-чипы «чужие календари» (`SharedCalendarSource.userId`). Все id уже были в типах — бэкенд НЕ трогали.
- F4 передача владения орг. (`workspaces/.../profile/[section]`) — нативный `<select>` людей → `EntitySelector`.
- F5 `PersonChip`/`Avatar` поддерживают фото (`avatar` prop → `<img>`), консистентно с мессенджером.
- F7 `getEquipState` само-залечивает висячие equip-ссылки (equip-поля без FK): если инстанс больше не принадлежит — пойнтер обнуляется (готово к трейду/удалению).
- F8 `GroupChip` уважает row/stack-раскладку (как `PersonChip`).
- F9 Lottie при загрузке/битом `effectUrl` откатывается на CSS-пресет.
- F10 сбой сети `/resolve` не кэширует null навсегда (ретрай при след. запросе).
- F11 токенизированы хардкоды: цвет presence-строки (`t.accent`), радиус кольца аватара (`t.avatarRadius` — чинит рассинхрон с Ретро-неон).
- F12 длинное имя в row-чипе (S/M) обрезается многоточием.
- F13 Группа в разделе «Скины» = `GroupChip` (была голым текстом).
- F14 автор чужого сообщения в чате = `PersonChip size=S` (мини-аватар+имя вместо текста).
- F15 синхронный ref-замок (`inFlight`) в `run()` SkinsSection — блокирует двойной клик «купить».
- F16 `@@unique([skinId, serial])` на `CardSkinInstance` (миграция `20260607000000_card_skin_serial_unique`, применена; NULL-серийники безлимиток не задеты).
- F17 сид-скрипт не опускает `supply` ниже уже выпущенного `minted`.
- F18 `buy` читает платформенную валюту ВНУТРИ транзакции (`getPlatformCurrency(tx)`).
**Отложено пользователем:** F2 (Lottie крутится в L-карточках грида Окружения на 100+ → перф; и общий кэш JSON), F6 (resolve отдаёт дефолтный скин зрителю без `ContactLink`/при блоке — должно зеркалить видимость).
Проверка: web tsc зелёный, nest build EXIT=0, verify-cardskins 23/0 (Σ=0).
- Статус: построено + хардненинг; закоммичено в main (2b4f47b); в браузере хардненинг визуально НЕ отсмотрен. Дальше: F2/F6 (по запросу), платёжные рельсы, трейд/подарки, регистрация dept/position/branch в EntitySelector, @username-чип, доп. скины. См. CLAUDE.md + авто-память.
