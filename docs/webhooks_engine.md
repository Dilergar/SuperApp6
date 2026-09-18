# Движок исходящих вебхуков (`core/webhooks`)

23-й платформенный движок: события организации доставляются в её системы подписанным HTTPS-запросом. Правило: **событие наружу — только `webhooks.emit(tx, …)`** в транзакции мутации; свой `fetch` наружу у сервиса запрещён (страж исходящих, [security.md](security.md)). Секреты — под движком ключей ([keys_engine.md](keys_engine.md)); управление — в разделе «Интеграции и ключи» рядом с ботами ([keys_api_access.md](keys_api_access.md)).

## Модель

- **`WebhookEndpoint`** — организация, `url` (только `https://`; `http://127.0.0.1` — лишь в development с `WEBHOOKS_DEV_LOOPBACK=true`), `events` (ключи реестра), `signing` `hmac|ed25519`, `secretEnc` (+ `prevSecretEnc`/`prevExpiresAt` на время ротации; envelope под KEK организации, реестр колонок движка ключей → rewrap), для Ed25519 — `privateKeyEnc` + `publicKey` (raw 32 байта, base64, в DTO), статус `pending_verification | active | disabled`, серия провалов — `failures` (штук подряд) + `failingSince` (когда серия началась) + `lastFailureAt` (таймер предохранителя), `disabledReason` (`failures | manual | platform | verification | signature_audit`), `lastDeliveryAt`, `lastProbeAt`. Адрес нормализуется у формы: логин/пароль в адресе, приватные сети, `.internal`/`.local`, метаданные облака и числовые формы loopback — `400 keys.webhook.url_rejected` сразу (предпроверка; настоящий щит — `safeFetch` на каждой доставке, имя можно перевесить после создания); фрагмент срезается.
- **`WebhookDelivery`** — одна доставка: `eventKey`, `payload` (тело события целиком — подписывается как есть), статус `pending | failed (ждёт ретрая) | delivered | exhausted`, `attempts`, `nextAt`, `lastStatus`, `lastError`. Ретеншн 30 дней (крон).
- **Реестр событий** — `packages/shared/src/keys/webhook-events.ts` (`defineWebhookEvents` по сервисам, версия формы payload): `tasks.task.created|completed|cancelled`, `documents.document.registered|signed`, `workspaces.member.joined|left`; служебные `webhook.ping` (проверка адреса) и `webhook.test` (аудит) — подписаться нельзя. Каталог — `GET /webhooks/events`.

## Продюсер

```ts
await this.webhooks.emit(tx, { workspaceId, eventKey: 'tasks.task.created', payload: taskWebhookPayload(created) });
```

В транзакции мутации (outbox: строки доставок и джобы `webhooks.deliver` ложатся атомарно с фактом; откат — ничего не уходит); без подписчиков — no-op; `workspaceId = null` (личные данные) — событие никуда не уходит. `emit(null, …)` допустим, только когда у продюсера транзакции нет вовсе: движок открывает собственную (строка доставки без джоба висела бы вечно), но событие уже не атомарно с фактом. **Событие объявляет победитель статус-гварда**: `emit` стоит внутри транзакции клейма под `if (count)` — проигравший гонку (двойной клик, отменённый документ) не шлёт ничего. Payload — только id, коды и деловые поля (название задачи, номер документа); **никогда** ПДн третьих лиц, описания, секреты, содержимое файлов. Новое событие = строка реестра в shared (+ `keys.webhook.events.<key>` в трёх каталогах) + `emit` у владельца данных. Продюсеры сейчас: `TasksModule` (создание в tx; завершение — в ДВУХ точках, где задача реально становится `done`: «Готово» у задачи без исполнителей и `recomputeStatus` на последней приёмке — сдача работы событием не является; отмена руками и системой), `DocumentsModule` (регистрация номером, подписание — обе двери, в транзакции клейма), `WorkspacesModule` (принятие приглашения — только новое членство; исключение и выход — в транзакции удаления членства).

## Доставка (`webhooks.delivery.job.ts`)

- Тело: `{ id: "msg_<delivery id>", type, version, occurredAt, data }`; заголовки **Standard Webhooks** — `webhook-id`, `webhook-timestamp` (секунды), `webhook-signature` = `v1,<base64>` на каждый живой HMAC-секрет (текущий + prev до срока) и `v1a,<base64>` для Ed25519, через пробел; подписываемая строка `<id>.<timestamp>.<raw body>`; **ключ HMAC — UTF-8 байты секрета `sa6_whs_…` целиком** (без `whsec_`-base64). `User-Agent: SuperApp6-Webhooks/1`.
- Транспорт — `safeFetch` (SSRF-щит: публичные адреса, DNS-проверка, редиректы не следуем — 3xx = провал), таймаут 10 с; тело ответа не читается. **2xx = успех** (`delivered`, серия обнуляется целиком, `lastDeliveryAt`); иначе — `failed`, ретрай бэкоффом движка джобов: паузы 30 с × 2^(n−1) с капом 12 ч, 16 попыток ≈ 65 часов (получатель пережидает выходные) → `exhausted`. Кап — СВОЙ у типа джоба (`backoffCapMs`): общий часовой кап движка сжал бы окно до ~5 часов. `lastError` несёт причину (`fetch failed: ECONNREFUSED`, `Timed out after 10000 ms`), а не голое «fetch failed».
- **Автоотключение — порог штук И возраст серии**: `failures ≥ 50` И серия длится ≥ 24 ч (`failingSince`) → `disabled/failures` + уведомление `webhook.endpoint.disabled` владельцу и админам (адрес в нём без query — токены получателя живут там) + журнал + аналитика `webhooks.endpoint.disabled` + сокет `keys:changed`. Одного счётчика мало: 50 событий за минуту перезапуска получателя отключали бы живой адрес (модель Stripe/Svix — «дни провалов», не штуки).
- **Предохранитель мёртвого адреса**: после 5 провалов подряд в сеть ходит ОДНА пробная доставка за паузу (30 с × 2^k, не дольше 15 мин) — её берёт джоб, атомарно передвинувший `lastFailureAt`; остальные откладываются `JobSnoozeError` без расхода попыток и без похода в сеть. Иначе чёрная дыра одного арендатора держит слоты общей очереди по 10 с на событие. Успех пробной обнуляет серию — отложенные уходят сами. Метрика `webhooks_delivery_snoozed_total`. Пинг предохранитель не держит (инструмент диагностики админа).
- **Проверка адреса**: при создании и при включении шлётся `webhook.ping` живой подписью; 2xx → `active` (журнал `webhook.endpoint.verified`, сокет `keys:changed`); до этого endpoint не получает ничего. У пинга 6 попыток (~15 минут): не дождались 2xx — `disabled/verification` с уведомлением, а не вечное «ждёт проверки». `POST …/probe` — пинг руками; живой пинг (`pending | failed`) у endpoint'а один — пачка «Пинг»/«Включить» доставок не копит.
- **Аудит битой подписью** (модель Discord, `webhooks.probe.cron.ts` раз в сутки → джоб `webhooks.probe`, дольше всех не проверявшиеся — первыми; постановка с приоритетом ниже доставки, cap очереди у обоих типов один — волна проб доставку не сужает и не обгоняет): активному endpoint'у уходит `webhook.test` с заведомо НЕвалидной подписью; ответ 2xx означает, что получатель подписи не проверяет → `disabled/signature_audit` + уведомление. Получатель ОБЯЗАН проверять подпись и отвечать не-2xx на битую.
- **Повтор** (`POST …/deliveries/:id/redeliver`) — та же строка (тот же `webhook-id`, получатель дедуплицирует), попытки с нуля; ждущий ретрая джоб этой доставки снимается (`cancelByUniqueKey`), иначе «Повторить» молча ждал бы чужого бэкоффа.
- **Ретеншн** — 30 дней по возрасту строки, без оглядки на статус (строка старше окна ретраев в `pending`/`failed` — сирота), пачками по 5000.

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

`GET /webhooks/events` · `GET|POST /workspaces/:id/webhooks/endpoints` · `PATCH …/:id {events?, enabled?}` (выключение — `manual`; включение — снова через пинг) · `POST …/:id/rotate-secret` · `POST …/:id/probe` · `DELETE …/:id` · `GET …/:id/deliveries` (курсор) · `POST …/:id/deliveries/:deliveryId/redeliver`. Гейт — owner/admin (`assertManager` движка ключей), создание и ротация — под step-up `keys_manage`, `@NoApiKeys()`. Тариф `webhooks.maxEndpoints` считает живые (не `disabled`) — поэтому его проходит и создание, и ВКЛЮЧЕНИЕ (иначе «создал → выключил → создал → включил все» обходит потолок). **Стоп-кран платформы** (`webhooks.platform.ts`, реестры кабинета — своих контроллеров под `/platform` нет): команды `webhooks.endpoint.disable` (ставит причину `platform`; ложится и ПОВЕРХ отключения организацией — иначе админ включил бы адрес сам) и `webhooks.endpoint.enable` (снимает только свой замок, дальше тот же путь — тариф и пинг), обе `keys.write`, high, с причиной; панель `workspace.webhooks` в карточке организации (адреса без query, без секретов). Отключённое платформой организация не включает — `409 keys.webhook.platformDisabled`. Переходы — статус-гвардами: из двух одновременных «Включить» пинг шлёт один; из двух ротаций побеждает одна (`409 keys.webhook.rotationRace`), проигравшему чужой секрет не показывают. Ручные пинги и повторы — не больше 30 в час на endpoint (`429 keys.webhook.tooManyManual`): платформа — не пушка по чужому адресу. журнал ключей (`subjectType: webhook_endpoint`: created/updated/enabled/disabled/deleted/secret_rotated/verified); реестр ключей показывает endpoint'ы строками `webhook` (`WebhooksRegistryPort` — направление «вебхуки → ключи», без импорта модуля). Веб — вкладка «Вебхуки» раздела «Интеграции и ключи» (`WebhooksTab`: форма адрес → подпись → события по сервисам, секрет show-once, карточка с доставками, «Повторить», «Пинг», ротация, вкл/выкл; статус обновляется сокетом `keys:changed` без перезагрузки; переход из уведомления `?tab=webhooks&endpoint=<id>` раскрывает доставки этого endpoint'а). Служебные события в списке доставок — ключи `webhook.events.webhook_ping|webhook_test`.

## Dev и сьют

`WEBHOOKS_DEV_LOOPBACK=true` (только development/test; в production env-страж роняет бут) разрешает `http://127.0.0.1` — доставка идёт `trustedFetch` (loopback приватен by design). `verify-webhooks.cjs` поднимает приёмник на 127.0.0.1 и проверяет подпись (HMAC и Ed25519, ротация двумя подписями), пинг → active, провал → failed → probe → active, повтор с тем же `webhook-id`, аудит битой подписью → `signature_audit` + уведомление, гейты, реестр, журнал. Сверх того сьют проверяет: отказ адреса у формы; `tasks.task.completed` на главном пути ровно один раз; пачку пингов; мгновенный «Повторить»; `verification`; автоотключение «штуки И возраст»; предохранитель; потолок тарифа на включении; `429` ручных действий. Дев-полигон — `webhooks.dev.ts` (контроллер движка, регистрируется только в dev; путь исторический): `POST /keys/dev/webhooks/probe {endpointId}`, `…/daily`, `…/deliver {deliveryId, attempt, maxAttempts}` (прогнать попытку N из M — исчерпание пинга, последняя попытка), `…/streak {endpointId, failures, failingHours, lastFailureSecAgo}` (состарить серию — учения автоотключения и предохранителя за секунды).

## Ловушки

- Endpoint в `pending_verification` получает ТОЛЬКО пинг: события, случившиеся до проверки, не доставляются (по дизайну — адрес ещё не подтверждён).
- Payload > 64 КБ — `400 keys.webhook.payloadTooLarge` у продюсера: класть ссылки/ids, не вложения.
- Один приёмник на несколько endpoint'ов получает событие столько раз, сколько endpoint'ов подписано — различать по секрету/`webhook-id`.
- **Архивная организация наружу не говорит**: `emit` её endpoint'ы не видит, хвост ретраев гаснет (`exhausted`, `workspace archived`), ночной аудит её пропускает. Статусы endpoint'ов архив не трогает — восстановление возвращает всё как было.
- Порядок доставки НЕ гарантирован (ретраи, параллельные слоты): получатель упорядочивает по `occurredAt` и дедуплицирует по `webhook-id`.
- Отключение гасит и хвост: доставки отключённого endpoint'а на следующей попытке уходят в `exhausted`. После включения их возвращает только «Повторить» по строке (30 дней).
- Отложенная предохранителем доставка попыток не тратит — её `attempts` не растёт, `nextAt` показывает конец паузы. «Висит в `failed`, а попыток мало» у мёртвого адреса — это предохранитель, не потерянный джоб.
- `failures` считает попытки, а не события; но отключает только серия, которая ещё и длится сутки.
- Новое событие у продюсера — искать точку, где факт СТАНОВИТСЯ правдой (производный статус считает `recomputeStatus`, а не кнопка): событие у кнопки врёт при соисполнителях и молчит на главном пути.

## Связанные доки

[keys_engine.md](keys_engine.md) · [keys_api_access.md](keys_api_access.md) · [jobs_engine.md](jobs_engine.md) · [security.md](security.md) · [notifications_engine.md](notifications_engine.md) · [module_graph.md](module_graph.md)
