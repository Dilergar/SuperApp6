# core/notifications + core/realtime — история решений грилла (2026-09-06/07)

Канон архитектуры — `docs/notifications_engine.md`, `docs/realtime_engine.md`. Здесь — ПОЧЕМУ так, бенчмарки и отвергнутые варианты.

## Бенчмарк (два отчёта, 2026-09-06)

- **Odoo** `mail.message` + `mail.notification` — событие один раз, строка на адресата с состоянием; взято как модель данных (B1). Ретрай фанаута безопасен через unique на паре (сообщение, партнёр) → у нас леджер `NotificationDelivery(eventId, userId, channel)`.
- **Knock** — PreferenceSet как разреженные переопределения (нет строки = дефолт), workflow batch (наш push-батчер `uniqueKey push:<userId>`), throttle (burst guard), «critical пробивает всё».
- **Novu** — 4 приоритета (critical неотключаем), digest продлевается до конца тишины → ОДИН сводный push после тишины; правило «частное побеждает» в прецеденте тип > сервис > политика > реестр.
- **Slack** — per-workspace наборы БЕЗ общего слоя (копирование вместо наследования), DND личный (организация дефолт тишины не задаёт), «дефолты дороже гранулярности» (два уровня: сервис × канал, раскрываемый до типов), бейджи по воркспейсам (точки в ContextSwitcher).
- **GitHub** — inbox с состояниями seen/read/done/saved, `reason` на строке (mention/assigned/…), mute объекта не глушит личное упоминание, Saved вечно при ретеншне 90 дней.
- **Teams / FCM** — chainId / collapse_key: схлопывание ПРИ ЗАПИСИ; `collapse: 'type'` скоупится контекстом («12 смен → одна строка»).
- **Salesforce Delivery Settings + Courier REQUIRED + Teams policy** — политика организации v1 = дефолты + замки (`default_on|default_off|locked_on`), замок только in-app/push (SMS — деньги организации и номер человека).
- **Jira** — «не check() в цикле»: `NotificationRefRegistry.canViewMany` батчем; presence-отложка 10 мин у Jira → у нас 2 мин.
- **Android importance** — 4 уровня приоритета как основа дефолта каналов.
- **Chrome best practice** — разрешение на push спрашивать карточкой/тумблером, не при загрузке.
- **Bitrix24 простой/расширенный, Kaspi «сервис»** — матрица сервисов с раскрытием до типов.

## Отвергнуто / не делать

- Общий слой предпочтений поверх контекстов (Slack его не имеет — сложность без пользы).
- Unique на строке ленты `(eventId, userId)` как идемпотентность — ретрай после схлопывания накручивал бы `collapseCount`; заменено леджером доставки.
- `emitEvent` + центральная карта `notifications.map.ts` — семантика «кому» принадлежит фиче; шина at-most-once не годится для уведомлений (outbox `send(tx)`).
- Отдельная модель `Mention` и лента `/mentions` — слито в центр (фильтр `mentions=1`, `reason: 'mention'`).
- Свой gateway у каждого сервиса — один сокет `/realtime` с реестром relay/хендлеров.
- «Удалить» в меню строки — только «Готово»; `DELETE` остаётся в API для AI/интеграций.
- Email-канал в UI — контракт есть, доставки нет (нет SMTP и верификации почты) → не показывать.
- Живой Expo/FCM сейчас — модель `NotificationDevice` + контракт `PushDriver` готовы, драйвер на mobile-этапе.
- `share.link.opened.muted` как отдельный тип — заменён `collapse: 'ref'` + `throttle {86400, 20}`.

## Ловушки стройки (для следующего, кто трогает движок)

- `dev/send` ставит `actorId = caller`, а актор вычитается из адресатов → «сам себе» ничего не приходит без `includeActor: true`.
- Строка ленты текста НЕ хранит: сьюты читают `event.payload`/`event.snapshot`, а не `notification.title`.
- `check:i18n` 5b считает `<a>.<b>.title` типом реестра — UI-ветки каталога (`settings.*`, `page.*`, `policy.*`…) перечислены в `UI_BRANCHES`.
- Логи/Swagger нового движка — по-английски: ратчет `i18n.legacy.json` только сжимается, новые файлы туда не вписываются.
- Screenshot в Browser pane при эмулированном вьюпорте и `window.scrollY > 0` смещён на величину прокрутки — проверять DOM через JS, кликать по `getBoundingClientRect()*масштаб`.
- Сокет-сьюты (`verify-messenger-socket`, `-presence`, `-logout-socket`) — namespace `/realtime`, не `/messenger`.
