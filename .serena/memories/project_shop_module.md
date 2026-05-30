# My Wish & Shop — Module (Phase 2 built, on the unified access engine)

Marketplace service. Phase 2 = catalog skeleton (no buying yet; buying = Phase 3). Part of the 9-phase plan in `mem:project_wish_shop_design`.

## Product model (important — avoid the "marketplace" misread)
My Wish & Shop is a PERSONAL shop + personal wishlist that the user shares with people from their Окружение. NOT a public marketplace (that's a separate FUTURE SuperApp6 Marketplace).
- **owner** = the user who owns the shop.
- **co-manager** (engine relation `manager`) = a person the owner ADDED FROM THEIR ОКРУЖЕНИЕ to run the shop together (e.g. wife adds husband to co-edit the kids' showcases). A co-manager can edit/see ALL showcases. This is NOT a hired marketplace seller — just a co-runner.
- **showcase sharing** (`viewer`) = who can SEE a given showcase + its listings (a person, or a Circle Group like «Семья»).
- **B2B** = a company's INTERNAL shop for its employees. Workspace owner/admins auto-manage. (Adding a non-admin employee co-manager by workspace membership = future B2B phase; today assignStaff still uses the personal-окружение check, fine for B2C.)

## Access — UNIFIED ENGINE `core/access` (NOT a per-domain table anymore)
ShowcaseShare table + UserRole(context shop/showcase) were DROPPED (migration `access_legacy_cleanup`). Shares & staff are TUPLE-NATIVE; ownership & parent are PROJECTED. Tuples:
- `shop:<id>#owner@user`                      (personal shop owner)        → capability `shop.manage`
- `shop:<id>#manager@workspace:<ws>#admin`    (company shop)               → `shop.manage`
- `shop:<id>#manager@user`                    (co-manager added from окружение)
- `showcase:<id>#parent@shop:<id>`            (inheritance pointer)        → showcase managers/viewers derive from the shop
- `showcase:<id>#manager@user`                (per-showcase co-manager)    → `showcase.manage`
- `showcase:<id>#viewer@user` | `@circle:<id>#member`  (shares)            → `showcase.view`
Schema rules (access-schema.ts): shop.manager=union(this,owner); showcase.manager=union(this, parent→shop.manager); showcase.viewer=union(this, manager). So co-managers/owners auto-see+manage every showcase; viewers see only shared ones. Capabilities (access-capabilities.ts): shop.manage→shop.manager, showcase.view→showcase.viewer, showcase.manage→showcase.manager.

ShopService delegates ALL authz to AccessService: canManageShop=access.can(shop.manage), canViewShowcase=access.can(showcase.view), loadShowcaseManageable=access.can(showcase.manage), listShowcasesFor non-manager + listAccessibleShops = access.listObjects(viewer, showcase). Removed the old copied graph-walks (no more shop full-scan).

## Projection (who writes the tuples)
- Shop ownership: `ensureShopOwnerTuple` in getOrCreateShop (check-then-grant, self-healing) + `AccessProjectionService.backfillShops` (cron/backfill, additive).
- Showcase parent: granted in createShowcase; revoked via `access.revokeResource('showcase', id)` in deleteShowcase.
- Shares: shareShowcase/unshareShowcase → access.grant/revoke viewer tuple (user or circle#member).
- Staff: assignStaff/revokeStaff → access.grant/revoke manager tuple (shop or showcase scope); listStaff reads manager tuples.
- Circle membership (for circle#member usersets): projected by CirclesService hooks (circleMemberAdded/Removed/Deleted) + reconcileCircles. Workspace roles (for shop#manager@workspace#admin): projected by RolesService.invalidateUserCache→resyncUserWorkspaceRoles + reconcileWorkspaceRoles. Both wired & live.
- **Atomicity:** showcase create/delete + shop create write the domain row and its access tuple in ONE $transaction (AccessService.grant/revoke/revokeResource accept an optional `tx`), so a transient projection failure can't orphan a showcase or lock an owner out. (Hardened 2026-05-30.)

## Models (apps/api/prisma/schema.prisma; migration 20260529060000_shop_phase2 additive; ShowcaseShare since DROPPED by access_legacy_cleanup)
Shop (1/owner @@unique[ownerType,ownerId]), Showcase (shopId,name,icon,sortOrder — NO shares relation now), Listing (FULL schema: itemType material|nonmaterial, withTask+taskDays, crowdfunding, stock, time window, discount, status, sourceWishItemId; Phase 2 only CRUD+display), ListingPrice (currencyId, amount; MULTI-ROW = cross-currency price, P5 ✅; FK-free to Currency, validated). OrderPrice mirrors ListingPrice (snapshot of an order's N price lines; FK to Order cascade, FK-free to Currency). OrderContribution (P6 crowdfunding: a pledge per (campaign, contributor, currency) = one escrow leg; FK to Order cascade). Order gains `crowdfunding` flag + status 'funding'; partial-unique index `orders_active_campaign_per_listing` = ≤1 active campaign per listing. Order also gains `expiresAt` (P7 crowdfunding deadline). The Listing stock/window/discount fields (added inert in Phase 2) are now ENFORCED (P7). `WishItem` (P8: owner/title/description/link/itemType/status; NO price; `Listing.sourceWishItemId` links a copied lot back to its wish).

## Files / endpoints
- `apps/api/src/modules/shop/` shop.service/controller/module (module: no special imports — AccessService/DatabaseService/WorkspaceContextService all @Global). shared: types/validation/constants/shop.ts; module def in constants/modules.ts.
- web: app/shop/page.tsx (tabs Shops|Wishlist, showcase rail, listing cards, listing/share/staff modals, shop switcher) + dashboard tile.
- `/api/shop/`: GET / · GET /accessible · GET /of/:ownerId · POST/PATCH/DELETE /showcases[/:id] · GET /showcases/:id/listings · POST /showcases/:id/shares · DELETE /showcases/:id/shares/:principalType/:principalId · POST/PATCH/DELETE /listings[/:id] · GET/POST /staff · DELETE /staff/:userId?scope=&showcaseId=

## Pricing gate
createListing resolves the owner's active currency (user→personal coin; workspace→company currency). None → 400. Defers B2B selling to the B2B-wallet phase.

## Verified
`apps/api/scripts/verify-shop.cjs` (HTTP e2e: share to person + Group → viewer sees only shared; 403 on others; co-manager sees all). Wallet (Phase 1) is fully decoupled from the engine (grep: zero access refs in modules/wallet).

## Phase 3 ✅ BUILT (orders) — purchase with escrow
- `Order` model in `shop` (migration `20260530120000_shop_orders`; listingId nullable SetNull + titleSnapshot so orders survive listing deletion; sellerId = shop owner = escrow beneficiary).
- Endpoints: `POST /shop/listings/:id/buy` (buyer needs `showcase.view` + enough of the OWNER's currency; escrow.fund refType='order', payer=buyer→beneficiary=owner; freeze throws → 400 on insufficient), `GET /shop/orders` (mine), `GET /shop/orders/incoming` (shops I manage via access.listObjects manager), `POST /shop/orders/:id/confirm` (showcase.manage → escrow.capture → settled), `/reject` (release), `/cancel` (buyer → release).
- Settlement BY ITEM TYPE: instant (non-material, or material WITHOUT task) → capture on confirm. Material «с задачей» purchase is BLOCKED in Phase 3 (→ Phase 4: task on owner, capture on buyer acceptance). Can't delete a listing with an active (pending/confirmed) order.
- Notifications `shop.order.placed|confirmed|rejected|cancelled` (EventBus emit in ShopService → NotificationsEventsListener onPattern('shop.*')). ShopService now also injects EventBusService + EscrowService (ShopModule imports WalletModule).
- Web: «Купить» on accessible listing cards (instant only) + «Заказы» tab (incoming confirm/reject, my purchases cancel).
- Verified `apps/api/scripts/verify-order.cjs` (buy→freeze→confirm→capture, reject/cancel→refund, insufficient→400, can't-delete-with-active-order→400, material+withTask→400) + verify-shop regression green.

## Phase 4 ✅ BUILT (with-task fulfilment)
- Material «с задачей»: confirmOrder → tasks.createTask(creator=buyer, executor=owner, reward=0, due=now+taskDays||7), order='confirmed' (NO capture). Buyer accepts the delivery → task.completed → ShopEventsListener (onPattern task.*) → ShopService.onFulfillmentDone(taskId) → escrow.capture(refType='order') → order='settled'. Async (EventBus), so e2e polls.
- Non-material «с задачей»: confirmOrder → capture now (settled) + calendar.createEvent(owner, participants=[buyer], now+N) (try/catch — non-critical), order.eventId stored.
- Owner refund of an in-fulfilment (confirmed) order: POST /shop/orders/:id/refund (showcase.manage) → escrow.releaseAll + order='refunded' + cancel the task (tx.task.updateMany status cancelled). Buyer CANNOT cancel a confirmed order.
- Order +taskDays (snapshot for due date) +eventId +@@index([taskId]); migration 20260530140000_order_fulfilment_fields. ShopModule imports TasksModule + CalendarModule; new shop.events.ts (ShopEventsListener). Material «с задачей» purchase UNBLOCKED in buy().
- Web: Buy works for material+withTask; OrdersView shows «в работе», owner «Вернуть», buyer «Принять в Задачнике →».
- Verified verify-order-fulfilment.cjs + verify-order/verify-shop/verify-ledger regressions green. (verify-shop assertions made inclusion-based — tolerate the user's real «Жене» showcase.)

## Phase 5 ✅ BUILT (cross-currency price)
- Price = N currency lines (own + currencies issued by people in the owner's окружение). create/updateListing accept `prices:[{currencyId,amount}]` (or `priceAmount` shorthand → one line in own currency). updateListing REPLACES the whole price (deleteMany+createMany in a tx). Zod `pricesArray`: 1..SHOP_LIMITS.maxPriceLines(5), no dup currency, amount≥1; create requires priceAmount OR prices.
- `resolvePrices(shop,data)` validates every currency is the owner's own OR an окружение contact's (else 400). `ownerPriceableCurrencies(ownerType,ownerId)` = own + contacts' active currencies (B2C; workspace owner → [], company currency = P9).
- New `GET /shop/currencies` → `AccessibleCurrencyDto[]` (own first, `isOwn`, `issuerName`) for the price-editor picker → `ShopService.accessibleCurrencies`.
- `Order` price is now snapshot `OrderPrice[]` (migration `20260530160000_order_prices_crosscurrency`: dropped Order.currencyId/amount, added order_prices, data-migrated existing orders to one line each). **EscrowService was ALREADY multi-leg/cross-currency** (one EscrowHold per payer×currency) — buy() funds ONE leg per currency in ONE $transaction = all-or-nothing (buyer lacking ANY currency → 400, full rollback). Guard: every price currency must be status='active' (deleted currency → lot unbuyable → 400). confirm capture (no beneficiary filter) settles ALL legs to owner; reject/cancel/refund releaseAll = all legs. NO escrow/confirm/refund logic changes needed.
- Order DTO: `prices: ListingPriceDto[]` replaces single currencyId/amount/currencyName/currencyIcon/scale; OrderStatus gained 'refunded'. serializeOrder + all order loaders use ORDER_INCLUDE={prices:true}.
- Web: ListingForm multi-currency editor (fetch /shop/currencies; add/remove lines; per-line dropdown filtered to avoid dups; own-first; keeps a no-longer-accessible currency selectable when editing). ListingCard + OrdersView render `fmtPrices(prices)` = "100🅰️ + 50🌟".
- Verified `apps/api/scripts/verify-crosscurrency.cjs` (2-currency price; picker own+contact; dual freeze; dual capture to owner; atomic rollback when missing one currency) + all P1–4 regressions green. nest build + web tsc green. Browser not visually checked.

## Phase 6 ✅ BUILT (crowdfunding)
- A crowdfunded listing (flag `crowdfunding`) is collected jointly: one campaign = one `Order` (status 'funding'), goal = its `OrderPrice[]` (multi-currency), pledges = `OrderContribution` rows. `POST /shop/listings/:id/contribute` {contributions:[{currencyId,amount}]} find-or-creates the listing's single active campaign (partial-unique index), then freezes ONE escrow leg per pledged currency in one tx (row-locks the campaign `SELECT … FOR UPDATE` to serialise) — all-or-nothing (lacking any currency → throws → rollback; line capped to remaining; over-pledge/double-pledge → 400). Funded when EVERY goal currency is filled → status 'pending'; emits `shop.order.funded` (→ owner).
- `POST /shop/orders/:id/withdraw` — a contributor releases their bundle (escrow.release by payerUserId) while 'funding'; empties → campaign 'cancelled'. `GET /shop/orders/:id` — campaign detail (progress + contributors). `buy()` on a crowdfunding listing → 400.
- Owner `confirm` (status 'pending') → `fulfilmentParties(order)`: TOP contributor (largest naive sum of pledged amounts, tie→earliest) = recipient/Постановщик, the rest = observers (task) / participants (event). Material «с задачей» → `tasks.createTask(top, {executorId: owner, observerIds: rest}, {skipEnvironmentChecks:true})` (contributors aren't mutual contacts) → status 'confirmed', capture on top's acceptance (task.completed → onFulfillmentDone captures ALL legs). Non-material «с задачей» → capture all + calendar event with all contributors. Instant → capture all on confirm. reject/refund (allowed for funding|pending) → releaseAll.
- `EscrowService` was already multi-payer/multi-currency → NO escrow changes; capture (no beneficiary filter) settles every leg to the owner. Added `TasksService.createTask(.., {skipEnvironmentChecks})`. Order DTO gains `crowdfunding`, `raised[]`, `myContribution[]`, `contributors[]`; Listing DTO gains `campaign` (live progress for the card). Web: card progress bars + «Скинуться» modal (per-currency, remaining-aware) + OrdersView funding state/withdraw. listMyOrders includes campaigns I contributed to.
- Verified `apps/api/scripts/verify-crowdfunding.cjs` (multi-currency collect from 2 contributors → fund→pending→confirm→roles→accept→capture-all; buy-block; over/double-pledge 400; withdraw refund) + all P1–5 regressions green. nest build + web tsc green. Browser not visually checked.

## Phase 7 ✅ BUILT (limits / time / FOMO)
- **Stock:** `stockLimit` (null = ∞), `stockSold` counter. `reserveStock(tx, listingId)` = atomic conditional `UPDATE … SET stock_sold = stock_sold + 1 WHERE id = ? AND (stock_limit IS NULL OR stock_sold < stock_limit)` → 0 rows → 400 «распродано» (oversell-safe, in the buy/campaign-create tx so a failed escrow rolls it back). `restoreStock(tx, listingId)` (guarded `stock_sold > 0`) on cancel/reject/refund/withdraw-empty/expire. A settled order keeps the unit; a crowdfunding campaign reserves 1 at creation.
- **Window:** `assertSellable(listing)` (status active + now in [availableFrom, availableUntil]) gates buy() AND contribute() → 400 «ещё не началось» / «закрыто».
- **FOMO discount:** `effectivePrices(listing)` applies `discountPercent` (floor per currency, min 1) while now < `discountUntil`; the DISCOUNTED price is what's snapshotted onto OrderPrice (buy) / the campaign goal (getOrCreateCampaign) — locked at purchase/creation time.
- **ShopCron** (`shop.cron.ts`, Redis lock `cron:shop-sweep`, every 30 min) → `ShopService.archiveExpiredListings()` (active → archived where availableUntil < now) + `expireCampaigns()` (crowdfunding funding campaigns where expiresAt < now → escrow.releaseAll + cancel + restoreStock; expiresAt snapshotted = listing.availableUntil at campaign creation). Registered in ShopModule providers.
- Web: ListingForm adds Запас / «Ограниченное время»+days (→ availableUntil) / FOMO-скидка %+days (→ discountUntil). ListingCard: strike-through original + discounted price + «−d%», sold-out/closed/soon badges, «осталось N». No new DTO fields (Listing already carried stock/window/discount); no new endpoints.
- Verified `apps/api/scripts/verify-limits.cjs` (reserve→sold-out 400→restore-on-cancel→consume-on-settle; window before/after → 400; discount snapshotted = 50 not 100, captured to owner; archive sweep query) + all P1–6 regressions green. nest build + web tsc green.

## Phase 8 ✅ BUILT (wishlist)
- `WishItem` (owner, icon, title, description, **link** URL, **itemType** material|nonmaterial set by the OWNER, status active|fulfilled|archived). NO price (the copier sets it). `Listing.sourceWishItemId` (Phase-2 field) links a copied lot back to its wish.
- Wishlist visibility via the access engine: NEW resource type `wishlist` (access-schema: owner THIS, viewer union(THIS, owner)) + capability `wishlist.view`. Shares are tuple-native (`wishlist:<owner>#viewer@user|circle#member`), like showcase shares; self-access bypasses the engine (viewerId===ownerId).
- ShopService wish methods: listMyWishes ({items, shares}), createWish/updateWish/deleteWish/fulfillWish (owner-only), shareWishlist/unshareWishlist (assertInEnvironment for users / own-circle for circles), accessibleWishlists (access.listObjects viewer/wishlist), wishlistOf (access.can wishlist.view or owner), copyWishToShowcase, markWishFulfilledIfSourced.
- **copyWishToShowcase(copier, wishId, data)**: copier must see the wish (wishlist.view or own). Target = an existing showcase the copier manages OR a new one (newShowcaseName). Creates a Listing in the COPIER's shop with itemType from the wish, sourceWishItemId=wishId, prices (resolvePrices = own/contacts currencies) + crowdfunding/stock/window/discount from data, withTask=false. Then auto-shares the target showcase to the wish owner (grant showcase viewer tuple; best-effort try/catch).
- **Auto-fulfil**: when an order settles (confirmOrder instant path + onFulfillmentDone), `markWishFulfilledIfSourced(order.listingId)` → if the listing has sourceWishItemId, set that wish status='fulfilled'. Plus manual fulfillWish.
- Endpoints (all under `/shop`): GET/POST /wishes, PATCH/DELETE /wishes/:id, POST /wishes/:id/{fulfill,copy}, POST /wishes/shares + DELETE /wishes/shares/:type/:id, GET /wishlists/accessible, GET /wishlists/of/:ownerId. Web: Wishlist tab (my wishes CRUD + share + accessible switcher + view a friend's + «Добавить в витрину» modal: showcase/new + price/crowdfunding/stock/days/discount).
- Verified `apps/api/scripts/verify-wishlist.cjs` (create; share; accessible/of; 403 unshared; copy→lot w/ sourceWishItemId + target showcase auto-shared to owner; buy→confirm→wish auto-fulfilled) + all P1–7 regressions green. nest build + web tsc green.

## Phase 9 ✅ BUILT (B2B wallet) — FINAL; all 9 phases complete
- Money primitives generalized to ORG accounts: `LedgerService.getOrCreateHolderAccount(currencyId, ownerType, ownerId)` (user OR workspace treasury); `mint`/`burn` take `ownerType`/`ownerId`; `getBalanceFor`. `EscrowHold` + `payerType`/`beneficiaryType` (default 'user' → tasks/personal shop UNCHANGED); fund/collectBack/returnToHold resolve accounts via the stored types. Migration `20260531030000_b2b_wallet`.
- Company currency (CurrencyService): create/rename/delete/mintToTreasury (issuer=workspace, mint→treasury workspace account), getCompanyWallet, payEmployee (treasury→user posted transfer), getCompanyHolders.
- Wallet controller `/wallet/company/*` — owner-only, in workspace context (`requireWorkspaceOwner` checks `Workspace.ownerId` + `wsContext.activeWorkspaceId`): GET /company, POST/PATCH/DELETE /company/currency, POST /company/currency/mint, POST /company/pay, GET /company/holders.
- Company task rewards: `TasksService.freezeReward` self-detects a company task via the task's `workspaceId` → pays the COMPANY currency from the TREASURY (payerType='workspace'); `canFund` likewise.
- Company shop: `ownerPriceableCurrencies`/`ownerCurrency` return the company currency for a workspace shop; `buy`/`contribute` set beneficiaryType=shop.ownerType so payment lands in the treasury; `assertSharePrincipal` allows sharing a company showcase to a workspace MEMBER. «С задачей» blocked in company shops for now (executor can't be a workspace).
- Web: owner-only `/workspaces/[id]/wallet` (create/mint currency, treasury, pay-employee picker, holders) sending `X-Workspace-Id`; tile on the workspace home.
- Verified `apps/api/scripts/verify-b2b-wallet.cjs` (company currency → mint treasury → owner-only 403 → payroll → company task reward from treasury → company-shop buy to treasury → Σ=0) + ALL P1–8 regressions green.

## 🎉 ALL 9 phases of My Wish & Shop BUILT + e2e-verified (12 verify-*.cjs green). Future: real-money payment rails (bank top-up/withdraw/KYC/FX), the full public SuperApp6 Marketplace, company task assignment to colleagues (today still uses personal-окружение check).