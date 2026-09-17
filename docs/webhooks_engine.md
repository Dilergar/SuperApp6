# Движок исходящих вебхуков (`core/webhooks`)

23-й платформенный движок: события организации доставляются в её системы подписанным HTTPS-запросом. Правило: **событие наружу — только `webhooks.emit(tx, …)`** в транзакции мутации; свой `fetch` наружу у сервиса запрещён (страж исходящих, [security.md](security.md)). Секреты — под движком ключей ([keys_engine.md](keys_engine.md)); управление — в разделе «Интеграции и ключи» рядом с ботами ([keys_api_access.md](keys_api_access.md)).

## Модель

- **`WebhookEndpoint`** — организация, `url` (только `https://`; `http://127.0.0.1` — лишь в development с `WEBHOOKS_DEV_LOOPBACK=true`), `events` (ключи реестра), `signing` `hmac|ed25519`, `secretEnc` (+ `prevSecretEnc`/`prevExpiresAt` на время ротации; envelope под KEK организации, реестр колонок движка ключей → rewrap), для Ed25519 — `privateKeyEnc` + `publicKey` (raw 32 байта, base64, в DTO), статус `pending_verification | active | disabled`, `failures` (подряд), `disabledReason` (`failures | manual | platform | verification | signature_audit`), `lastDeliveryAt`, `lastProbeAt`.
- **`WebhookDelivery`** — одна доставка: `eventKey`, `payload` (тело события целиком — подписывается как есть), статус `pending | failed (ждёт ретрая) | delivered | exhausted`, `attempts`, `nextAt`, `lastStatus`, `lastError`. Ретеншн 30 дней (крон).
- **Реестр событий** — `packages/shared/src/keys/webhook-events.ts` (`defineWebhookEvents` по сервисам, версия формы payload): `tasks.task.created|completed|cancelled`, `documents.document.registered|signed`, `workspaces.member.joined|left`; служебные `webhook.ping` (проверка адреса) и `webhook.test` (аудит) — подписаться нельзя. Каталог — `GET /webhooks/events`.

## Продюсер

```ts
await this.webhooks.emit(tx, { workspaceId, eventKey: 'tasks.task.created', payload: taskWebhookPayload(created) });
```

В транзакции мутации (outbox: строки доставок и джобы `webhooks.deliver` ложатся атомарно с фактом; откат — ничего не уходит); без подписчиков — no-op; `workspaceId = null` (личные данные) — событие никуда не уходит. Payload — только id, коды и деловые поля (название задачи, номер документа); **никогда** ПДн третьих лиц, описания, секреты, содержимое файлов. Новое событие = строка реестра в shared (+ `keys.webhook.events.<key>` в трёх каталогах) + `emit` у владельца данных. Продюсеры сейчас: `TasksModule` (создание в tx, завершение обоих путей, отмена руками и системой), `DocumentsModule` (регистрация номером, подписание — обе двери), `WorkspacesModule` (принятие приглашения в tx, исключение, выход).

## Доставка (`webhooks.delivery.job.ts`)

- Тело: `{ id: "msg_<delivery id>", type, version, occurredAt, data }`; заголовки **Standard Webhooks** — `webhook-id`, `webhook-timestamp` (секунды), `webhook-signature` = `v1,<base64>` на каждый живой HMAC-секрет (текущий + prev до срока) и `v1a,<base64>` для Ed25519, через пробел; подписываемая строка `<id>.<timestamp>.<raw body>`; **ключ HMAC — UTF-8 байты секрета `sa6_whs_…` целиком** (без `whsec_`-base64). `User-Agent: SuperApp6-Webhooks/1`.
- Транспорт — `safeFetch` (SSRF-щит: публичные адреса, DNS-проверка, редиректы не следуем — 3xx = провал), таймаут 10 с; тело ответа не читается. **2xx = успех** (`delivered`, `failures = 0`, `lastDeliveryAt`); иначе — `failed`, ретрай бэкоффом движка джобов (база 30 с, кап 6 ч, до 12 попыток ≈ 3 суток) → `exhausted`. Каждая неудачная попытка увеличивает `failures` endpoint'а; ≥ 50 подряд → `disabled/failures` + уведомление `webhook.endpoint.disabled` владельцу и админам + журнал + аналитика `webhooks.endpoint.disabled`.
- **Проверка адреса**: при создании и при включении шлётся `webhook.ping` живой подписью; 2xx → `active` (журнал `webhook.endpoint.verified`); до этого endpoint не получает ничего. `POST …/probe` — пинг руками.
- **Аудит битой подписью** (модель Discord, `webhooks.probe.cron.ts` раз в сутки → джоб `webhooks.probe`): активному endpoint'у уходит `webhook.test` с заведомо НЕвалидной подписью; ответ 2xx означает, что получатель подписи не проверяет → `disabled/signature_audit` + уведомление. Получатель ОБЯЗАН проверять подпись и отвечать не-2xx на битую.
- **Повтор** (`POST …/deliveries/:id/redeliver`) — та же строка (тот же `webhook-id`, получатель дедуплицирует), попытки с нуля.

## Получатель (референс)

```js
const content = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${rawBody}`;
const ok = headers['webhook-signature'].split(' ').some((p) => {
  const [v, sig] = p.split(',');
  if (v === 'v1') return secrets.some((s) => createHmac('sha256', Buffer.from(s, 'utf8')).update(content).digest('base64') === sig);
  if (v === 'v1a') return crypto.verify(null, Buffer.from(content), ed25519PublicKey, Buffer.from(sig, 'base64'));
  return false;
});
// + |now − timestamp| ≤ 300 с; сравнение подписей — константным временем; дедуп по webhook-id
```

Ротация секрета (`POST …/rotate-secret {prevHours ≤ 24}`): новый секрет показывается один раз, старый подписывает параллельно до срока — получатель держит оба и переключается без простоя. Ed25519: публичный ключ в DTO endpoint'а, общего секрета нет.

## API и веб

`GET /webhooks/events` · `GET|POST /workspaces/:id/webhooks/endpoints` · `PATCH …/:id {events?, enabled?}` (выключение — `manual`; включение — снова через пинг) · `POST …/:id/rotate-secret` · `POST …/:id/probe` · `DELETE …/:id` · `GET …/:id/deliveries` (курсор) · `POST …/:id/deliveries/:deliveryId/redeliver`. Гейт — owner/admin (`assertManager` движка ключей), создание и ротация — под step-up `keys_manage`, `@NoApiKeys()`. Тариф `webhooks.maxEndpoints`; журнал ключей (`subjectType: webhook_endpoint`: created/updated/enabled/disabled/deleted/secret_rotated/verified); реестр ключей показывает endpoint'ы строками `webhook` (`WebhooksRegistryPort` — направление «вебхуки → ключи», без импорта модуля). Веб — вкладка «Вебхуки» раздела «Интеграции и ключи» (`WebhooksTab`: форма адрес → подпись → события по сервисам, секрет show-once, карточка с доставками, «Повторить», «Пинг», ротация, вкл/выкл).

## Dev и сьют

`WEBHOOKS_DEV_LOOPBACK=true` (только development/test; в production env-страж роняет бут) разрешает `http://127.0.0.1` — доставка идёт `trustedFetch` (loopback приватен by design). `verify-webhooks.cjs` поднимает приёмник на 127.0.0.1 и проверяет подпись (HMAC и Ed25519, ротация двумя подписями), пинг → active, провал → failed → probe → active, повтор с тем же `webhook-id`, аудит битой подписью → `signature_audit` + уведомление, гейты, реестр, журнал. Дев-ручки: `POST /keys/dev/webhooks/probe {endpointId}`, `POST /keys/dev/webhooks/daily`.

## Ловушки

- Endpoint в `pending_verification` получает ТОЛЬКО пинг: события, случившиеся до проверки, не доставляются (по дизайну — адрес ещё не подтверждён).
- Payload > 64 КБ — `400 keys.webhook.payloadTooLarge` у продюсера: класть ссылки/ids, не вложения.
- Один приёмник на несколько endpoint'ов получает событие столько раз, сколько endpoint'ов подписано — различать по секрету/`webhook-id`.
- Автоотключение считает попытки, а не события: один недоступный адрес с 12 ретраями × 5 событий уйдёт в `disabled` за час — включение руками снова проверяет адрес пингом.

## Связанные доки

[keys_engine.md](keys_engine.md) · [keys_api_access.md](keys_api_access.md) · [jobs_engine.md](jobs_engine.md) · [security.md](security.md) · [notifications_engine.md](notifications_engine.md) · [module_graph.md](module_graph.md)
