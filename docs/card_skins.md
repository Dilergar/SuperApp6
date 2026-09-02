# Скины карточек (CardSkinsModule)

> Платформенная косметика PersonCard: скин = ДАННЫЕ (токены оформления + слои рамка/фон/эффект). Монетизация платформы. НЕ в chokepoint (личная косметика).

Код: `apps/api/src/modules/card-skins/`; веб — `apps/web/src/app/circles/card-skin.ts`, `apps/web/src/app/circles/PersonCard.tsx`.

## Модель

- **`CardSkin`** (тип: токены, редкость 6 тиров, цена, тираж/окно) + **`CardSkinInstance`** (экземпляр-«вещь»: серийник у лимиток, `@@unique([skinId, serial])`; история передач `CardSkinTransfer` — задел трейда).
- Покупка — за платформенную валюту (`issuerType='platform'`, лениво) через двойную запись Ledger (Σ=0), мгновенно; резерв тиража оверселл-безопасен (атомарный `UPDATE … WHERE minted < supply`); ref-замок от двойной покупки.
- **Надевание**: один дефолтный скин всем + разные скины на Группы (премиум; конфликт → группа выше по sortOrder; премиум истёк → дефолт, настройки сохраняются).
- **Политика видимости (решение продукта)**: надетый скин виден ВСЕМ, кто видит карточку (окружение, коллеги, будущий маркетплейс) — косметика = публичный статус (модель Telegram Premium/Steam). Скины-на-группу действуют только для личных Групп.
- Эффекты: реальные Lottie (ассеты `apps/web/public/skins/`) с CSS-фолбэком, `prefers-reduced-motion`-aware, только в XL/L; `authorId` скрыт в UI.

## Движок скин-аватара (веб, переиспользуемый)

Хук `usePersonSkin` (`apps/web/src/lib/person-skins.ts`) — батч+кэш `/card-skins/resolve`; компоненты: `PersonAvatar` — `apps/web/src/app/messenger/messenger-ui.tsx`, `PersonChip` — `apps/web/src/app/circles/PersonCard.tsx`. Подключён ВЕЗДЕ, где показывается человек. Любой новый «человек» в UI = `<PersonAvatar/>` или `<PersonChip size .../>` — это и есть продуктовое правило Принципа 2 ([web_conventions.md](web_conventions.md)). Live-обновление после надевания — `invalidatePersonSkins`; само-залечивание висячих equip-ссылок.

## API (кратко)

`GET /card-skins/catalog` · `GET/POST /card-skins/wallet(+topup — ТЕСТ-пополнение)` · `POST /:skinId/buy` · `GET /inventory` · `GET/PUT /equip` (default | group) · `GET /resolve?userIds=` (слой для гридов).

## Отложено

Реальная оплата валюты, трейд/подарки/UGC, @username-чип, «скин на организацию» (премиум B2B), Lottie-перф в L-гриде.

## Проверка

`verify-cardskins.cjs`.
