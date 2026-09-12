# Entitlements Resolver — согласованный дизайн (грилл 2026-09-12)

Исследование: `research_entitlements_1..6_*.md` (Salesforce/Odoo · Bitrix24/M365/Slack/Atlassian · Telegram/Google One/Kaspi · Shopify/WeChat · Notion/Slack/Dropbox · архитектура Stigg/Schematic/OpenMeter/Kill Bill/Stripe).

## Решения пользователя (не пересматривать)

1. **Носитель подписки = контейнер + носитель у ключа.** Контейнеры: `user` (личное пространство, размер 1), `workspace`, `family` (зарезервирован, без UI). Каждый ключ реестра объявляет `carrier: container | person | both`. Person-ключи (скины) едут с человеком во все контексты; container-ключи не протекают между личным и рабочим.
2. **B2B продаётся пакетом, учёт местами.** Значения плана по всем ключам (места, объекты, юрлица, диск…) лежат в БД версиями; поверх — индивидуальные оверрайды на организацию по любому ключу. Ступени: `business_free / business_basic / business_standard / business_pro` + небольшое число add-on'ов (гранты источника `addon`). Подписки на отдельные сервисы НЕТ.
3. **Место занимает любой член trainee+.** `contractor` и гости share-links мест не занимают (число подрядчиков — отдельный ключ позже).
4. **Триалы 30/30.** Личный контейнер: 30 дней `personal` при регистрации. Организация: 30 дней `business_pro`, **один триал на человека** (только первая созданная организация; при миграции — самая старая живая организация каждого владельца). Существующие пользователи при миграции получают 30 дней `personal` с момента миграции.
5. **Неоплата = падение на free без потери данных.** Grace 15 дней (данные плана) — всё работает с баннером; затем free-значения: сверхлимитное читается и правится, новое сверх free не создать, платные фичи выключаются. Удаление — только руками владельца (архив 90 дней как сейчас). Эскроу, подпись начатого, экспорт — не гейтятся никогда.
6. **Первая волна — 9 ключей:** `workspace.seats` (limit, ws, 1000) · `files.storageBytes` (quota, владелец файлов: user 15 ГБ / ws 100 ГБ) · `workspaces.maxOwned` (limit, user, 20) · `objects.maxPerWorkspace` (limit, ws, 2000) · `legalEntities.maxPerWorkspace` (limit, ws, 20) · `skins.perGroup` (feature, person; замена `premiumUntil`) · `contacts.maxCircles` (limit, user, 50) · `shop.maxShowcases` (limit, both, 50) · `notifications.smsPerDay` (quota, ws, суточный сброс, 500). Остальные константы `*_LIMITS` переводятся по сервису за подход.
7. **Ключи планов в коде:** `free, personal, family` (личные) · `business_free, business_basic, business_standard, business_pro`. Названия для людей — каталоги i18n.
8. **Сид платных ступеней — политика-множитель как draft:** personal = free ×2; business basic/standard/pro: места 5/50/250, диск ×1/×5/×10. Версия помечена draft, цен нет и в UI не показываются.
9. **Управление каталогом:** платформенный API `/platform/entitlements/*` под ролью `platform_admin` (планы, версии, оверрайды, гранты) + сид первых версий. UI кабинета — позже на эти же ручки.
10. **Замок в UI без кнопок:** чип «Доступно на тарифе X» + счётчик «X из Y». В организации — «лимит тарифа организации», решает владелец. **Заявок сотрудников на расширение НЕТ** (отвергнуто: при 1000 сотрудников владельца завалит).
11. **Диск при исчерпании — жёсткий отказ (402) + уведомление на 80% и 100%.** Профили доказательств подписи вне квоты остаются.
12. **Уведомления организации — владельцу и админам** (через core/audiences), одно на порог за период. Типы: триал заканчивается (7/1 день), тариф истёк, grace начался, квота 80%/100%, места кончились.
13. **Объём стройки:** база (движок + реестр + планы + миграция + снимок API + 9 потребителей + замки + страницы «Тариф и лимиты» + сьют + доки) + уведомления. Без заявок, без семьи-UI, без платёжных рельсов.

## Архитектурные умолчания (приняты без возражений)

- Движок `core/entitlements` (19-й), фичи не импортирует; обратное — реестры (usage-провайдеры, i18n подписи ключей).
- Датамодель: `Plan` · `PlanVersion` (неизменяемая, `entitlements JSONB`, `region='KZ'`, `status draft|published|archived`) · `SubjectSubscription` (`subjectType user|workspace|family`, `planVersionId`, `status trialing|active|past_due|expired|cancelled`, `periodEnd`, `trialEndsAt`, `graceUntil`) · `EntitlementGrant` (единый слой: `source gift|trial|family|addon|manual|legacy`, `priority`, `validUntil`, `idempotencyKey`) · `EntitlementOverride` (`set|unlimited|deny`, `reason`, `validUntil` обязательны) · `QuotaCounter` (обобщение `FileQuotaUsage`: `key`, `periodStart/End`, `used`).
- Слияние по типу: feature = OR, limit = MAX, quota = SUM грантов, enum = ранг; override последним. Свободных значений нет: free = `defaultFree` реестра (константы становятся дефолтами — в день запуска поведение не меняется).
- Вход резолвера всегда `(userId, context: personal | workspace:X)`. Квота принадлежит владельцу данных (`ownerType/ownerId`), способность — контексту.
- Порядок в ручке: контекст → `access.can` (403, без апселла) → `entitlements.assert` (402) → резерв квоты в tx → эффект. Правило действует на ВСЕХ путях (приглашение, приём, найм «с порога»).
- Квота: один `UPDATE … WHERE used + delta <= :limit RETURNING`, лимит параметром из резолвера, ленивый сброс периода тем же стейтментом, возврат `GREATEST(used - delta, 0)`. Fail-closed.
- Кэш: Redis-снимок значений на субъект, эпоха ОТДЕЛЬНАЯ от `core/access`; ALS-мемо на запрос; истечение считается при чтении, джоб `entitlements.expiry` — будильник (бамп эпохи + уведомление + переход статуса). Push снимка через `core/realtime.registerRelay`.
- Отказ: HTTP 402 (`paymentRequired` в `api-error.ts`), `details.code`: `entitlement.feature_locked | limit_reached | quota_exhausted | plan_expired | seat_required`, плюс `unlock: {by: self|workspace_owner, plan?}` и `key/value/used`.
- API: `GET /me/entitlements?context=…` (снимок: plan, features, limits{value,used}, quotas{limit,used,resetAt}, sources, expiresAt) · `POST /entitlements/check` (батч, для AI) · `/platform/entitlements/*`.
- Наблюдаемость: событие шины `entitlement.denied {key, code, context}` (терять допустимо).
- Не делаем: Fair Billing по активности; значок «премиум» у имени; JWT-клеймы; удаление данных по неоплате; вторую модель прав рядом с ReBAC; подписки на сервис; заявки на апгрейд.
- Термин `entitlement` — только лицензирование; будущие SLA — `serviceLevel`.
