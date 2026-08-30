# My Wish & Shop (ShopModule)

> Каталог + покупка с эскроу: магазины, витрины, лоты, заказы, краудфандинг, лимиты/FOMO, вишлист; B2C и B2B-магазин. Дизайн — Serena `project_shop_module`.

## Модель

- **`Shop`** — 1 на владельца (user|workspace), лениво. **B2B-изоляция = явное владение ownerType+ownerId + права, НЕ chokepoint.**
- **`Showcase`** — витрина-папка; шеринг людям/Группам — через core/access (живой принципал circle); staff (scope shop|showcase) — тоже движком; `revokeStaff` проверяет принадлежность витрины.
- **`Listing`** — лот: тип, «с задачей»+дни, краудфандинг, запас `stockLimit`, окно `availableFrom/Until`, скидка `discountPercent/Until`, статус; **цена кросс-валютная** — `ListingPrice[]` (своя валюта и/или валюты людей из окружения; ни одной → 400). Фото — галерея ≤10 профилем listing_image (публичный класс; обложка = первое фото, батч без N+1).
- **`Order`** — снимок цены `OrderPrice[]` (N ног); эскроу refType='order' (нога на валюту: не хватает любой → 400, полный откат). Статусы двигаются status-guarded updateMany.
- **Краудфандинг**: кампания = Order статус funding; вклады `OrderContribution` (нога на вкладчик×валюту); всё-или-ничего; собрана по ВСЕМ валютам → pending → confirm → списание всех; withdraw пока funding (FOR UPDATE на кампанию); **топ-вкладчик → Постановщик** авто-задачи, остальные → Наблюдатели; buy() на краудфандинг-лоте → 400.
- **Исполнение**: материальное «с задачей» → авто-задача на владельца (списание при приёмке покупателем — синхронный `onFulfillmentDone` из Задачника + sweep в ShopCron как подстраховка); нематериальное → списание + событие в Календаре; refund «в работе» владельцем.
- **Лимиты/время/FOMO**: атомарный резерв запаса (оверселл-безопасно), окно продаж, скидка вниз до фикс-снимка; ShopCron (Redis-лок, 30 мин) — авто-архив после окна + авто-возврат просроченных кампаний (`Order.expiresAt`, take 200).
- **Wishlist**: `WishItem` (без цены), шеринг как витрина; «Добавить в витрину» → лот в МОЁМ магазине с sourceWishItemId (+авто-шер витрины владельцу хотелки); лот продан/собран → хотелка авто-«исполнено».
- **B2B-магазин**: лоты в компанийной валюте, витрины сотрудникам, покупки в казну; «с задачей» в магазине компании заблокировано.

## API (кратко)

`GET /shop` · `/accessible` · `/of/:ownerId` · `/currencies` · showcases CRUD + shares + listings · listings CRUD (+images) · staff · `POST /listings/:id/buy|contribute` · orders (list/incoming/:id + confirm/reject/cancel/refund/withdraw) · wishes CRUD + fulfill/copy + shares · wishlists accessible/of.

## Веб

`/shop` — вкладки Shops|Wishlist|Заказы; чужие магазины переключателем; модалки лота (мульти-валютный редактор цены)/шеринга/сотрудников; «Поговорить» на лоте → DM с карточкой товара; «Обсудить» на заказе → контекстный чат. ⚠️ Страница на старом useState-стиле (~70 useState) — переводить на RQ при следующей работе над магазином.

## Проверка

`verify-shop.cjs`, `verify-order.cjs`, `verify-order-fulfilment.cjs`, `verify-crosscurrency.cjs`, `verify-crowdfunding.cjs`, `verify-limits.cjs`, `verify-wishlist.cjs`, `verify-b2b-wallet.cjs`.
