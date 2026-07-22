import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Shop as ShopDto,
  Showcase as ShowcaseDto,
  Listing as ListingDto,
  ShowcaseShareDto,
  ShopStaffDto,
  AccessibleShopRef,
  ShopOwnerType,
  Order as OrderDto,
  AccessibleCurrencyDto,
  ContributionLine,
  WishItem as WishItemDto,
  AccessibleWishlistRef,
  CreateWishRequest,
  UpdateWishRequest,
  CopyWishRequest,
  CreateShowcaseRequest,
  UpdateShowcaseRequest,
  CreateListingRequest,
  UpdateListingRequest,
  ShareShowcaseRequest,
  AssignShopStaffRequest,
} from '@superapp/shared';
import { SHOP_LIMITS, publicVariantUrl } from '@superapp/shared';
import type { FileDto } from '@superapp/shared';
import { FilesService } from '../../core/files/files.service';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { DatabaseService } from '../../shared/database/database.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccessService } from '../../core/access/access.service';
import { AccessProjectionService } from '../../core/access/access-projection.service';
import { Principal, RelationTupleInput } from '../../core/access/access.types';
import { EscrowService } from '../wallet/escrow.service';
import { TasksService } from '../tasks/tasks.service';
import { CalendarService } from '../calendar/calendar.service';
import { ContactsService } from '../contacts/contacts.service';

type ShopRow = Prisma.ShopGetPayload<object>;
type ShowcaseRow = Prisma.ShowcaseGetPayload<object>;
const LISTING_INCLUDE = { prices: true } as const;
const ORDER_INCLUDE = { prices: true, contributions: true } as const;
type OrderWithDetail = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;
/** A resolved price line ready to persist (amount in minor units). */
type PriceLine = { currencyId: string; amount: number };

/**
 * My Wish & Shop — Phase 2 catalog. Access is decided by the unified engine (core/access):
 *   shop:<id>#owner@user            (personal shop)         → shop.manage
 *   shop:<id>#manager@workspace#admin (company shop)        → shop.manage
 *   shop:<id>#manager@user          (shop staff)
 *   showcase:<id>#parent@shop       (inherit shop managers) → showcase.manage
 *   showcase:<id>#manager@user      (showcase staff)
 *   showcase:<id>#viewer@user | @circle#member  (shares)    → showcase.view
 * Tuples are the source of truth for shares/staff; ownership/parent are projected from the
 * Shop/Showcase tables (live on create + AccessProjectionService.backfillShops). No chokepoint.
 */
@Injectable()
export class ShopService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly wsContext: WorkspaceContextService,
    private readonly access: AccessService,
    private readonly accessProjection: AccessProjectionService,
    private readonly escrow: EscrowService,
    private readonly events: EventBusService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TasksService,
    private readonly calendar: CalendarService,
    private readonly contacts: ContactsService,
    private readonly files: FilesService,
    private readonly filesRegistry: FilesRefRegistry,
  ) {}

  onModuleInit(): void {
    // Галерея лота (движок файлов): фото публичные, но резолвер обязателен для
    // полноты матрицы (attach гейтится showcase.manage; view — видимость витрины).
    this.filesRegistry.register('listing', {
      canView: async (viewerId, listingId) => {
        const listing = await this.db.listing.findUnique({
          where: { id: listingId },
          select: { showcaseId: true },
        });
        if (!listing) return false;
        return (
          (await this.access.can(this.user(viewerId), 'showcase.view', listing.showcaseId)) ||
          (await this.access.can(this.user(viewerId), 'showcase.manage', listing.showcaseId))
        );
      },
      canAttach: async (userId, listingId) => {
        const listing = await this.db.listing.findUnique({
          where: { id: listingId },
          select: { showcaseId: true },
        });
        if (!listing) return false;
        return this.access.can(this.user(userId), 'showcase.manage', listing.showcaseId);
      },
    }, { allowedProfiles: ['listing_image'] });
  }

  private user(id: string): Principal {
    return { type: 'user', id };
  }

  /** Обложка лота = первое фото галереи; thumb — только если вариант уже готов (К-4) */
  private coverUrlFrom(files: FileDto[] | undefined): string | null {
    return publicVariantUrl(files?.[0], 'thumb');
  }

  // ============================================================
  // My shop (owner resolved from the active context)
  // ============================================================

  /** The owner the viewer is currently acting as: the active workspace, else themselves. */
  private resolveOwner(viewerId: string): { ownerType: ShopOwnerType; ownerId: string } {
    const wsId = this.wsContext.activeWorkspaceId;
    return wsId ? { ownerType: 'workspace', ownerId: wsId } : { ownerType: 'user', ownerId: viewerId };
  }

  private async getOrCreateShop(ownerType: ShopOwnerType, ownerId: string): Promise<ShopRow> {
    const existing = await this.db.shop.findUnique({ where: { ownerType_ownerId: { ownerType, ownerId } } });
    if (existing) {
      await this.ensureShopOwnerTuple(existing); // self-heal a shop that predates the engine
      return existing;
    }
    try {
      // Create the shop AND its ownership tuple atomically — a transient projection failure must
      // never leave a shop whose owner can't manage it.
      return await this.db.$transaction(async (tx) => {
        const created = await tx.shop.create({ data: { ownerType, ownerId } });
        await this.access.grant(this.ownerTupleOf(created), tx);
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const shop = (await this.db.shop.findUnique({ where: { ownerType_ownerId: { ownerType, ownerId } } }))!;
        await this.ensureShopOwnerTuple(shop);
        return shop;
      }
      throw err;
    }
  }

  /** The ownership edge for a shop: the personal owner, or workspace admins for a company shop. */
  private ownerTupleOf(shop: ShopRow): RelationTupleInput {
    return shop.ownerType === 'user'
      ? { resourceType: 'shop', resourceId: shop.id, relation: 'owner', subjectType: 'user', subjectId: shop.ownerId }
      : { resourceType: 'shop', resourceId: shop.id, relation: 'manager', subjectType: 'workspace', subjectId: shop.ownerId, subjectRelation: 'admin' };
  }

  /**
   * Self-heal an EXISTING shop's ownership tuple (back-fills shops that predate the engine).
   * One indexed read on the hot path; only writes when missing.
   */
  private async ensureShopOwnerTuple(shop: ShopRow): Promise<void> {
    const t = this.ownerTupleOf(shop);
    const found = await this.db.relationTuple.findFirst({
      where: {
        resourceType: t.resourceType,
        resourceId: t.resourceId,
        relation: t.relation,
        subjectType: t.subjectType,
        subjectId: t.subjectId,
        subjectRelation: t.subjectRelation ?? '',
      },
      select: { id: true },
    });
    if (found) return;
    await this.access.grant(t);
  }

  /** My shop + my showcases (full, with audiences). */
  async getMyShop(viewerId: string): Promise<{ shop: ShopDto; showcases: ShowcaseDto[] }> {
    const { ownerType, ownerId } = this.resolveOwner(viewerId);
    const shop = await this.getOrCreateShop(ownerType, ownerId);
    const canManage = await this.canManageShop(viewerId, shop);
    const showcases = await this.listShowcasesFor(viewerId, shop, canManage);
    return { shop: await this.serializeShop(shop, viewerId, canManage, showcases.length), showcases };
  }

  /** View another owner's shop (only the showcases shared with the viewer). */
  async getShopOfUser(viewerId: string, ownerUserId: string): Promise<{ shop: ShopDto; showcases: ShowcaseDto[] }> {
    const shop = await this.db.shop.findUnique({ where: { ownerType_ownerId: { ownerType: 'user', ownerId: ownerUserId } } });
    if (!shop) throw new NotFoundException('Магазин не найден');
    const canManage = await this.canManageShop(viewerId, shop);
    const showcases = await this.listShowcasesFor(viewerId, shop, canManage);
    if (!canManage && showcases.length === 0) {
      throw new ForbiddenException('Нет доступа к этому магазину');
    }
    return { shop: await this.serializeShop(shop, viewerId, canManage, showcases.length), showcases };
  }

  /** Shops of OTHERS that have at least one showcase the viewer can see (the shop switcher). */
  async listAccessibleShops(viewerId: string): Promise<AccessibleShopRef[]> {
    const showcaseIds = await this.access.listObjects(this.user(viewerId), 'viewer', 'showcase');
    if (showcaseIds.length === 0) return [];
    const showcases = await this.db.showcase.findMany({
      where: { id: { in: showcaseIds } },
      include: { shop: true },
    });
    const byShop = new Map<string, ShopRow>();
    for (const sc of showcases) {
      const shop = sc.shop;
      if (shop.ownerType !== 'user') continue; // Phase 2 switcher: personal shops only
      if (shop.ownerId === viewerId) continue; // not my own
      byShop.set(shop.id, shop);
    }
    const shops = [...byShop.values()];
    const names = await this.userMinis(shops.map((s) => s.ownerId));
    return shops.map((s) => {
      const u = names.get(s.ownerId);
      return {
        shopId: s.id,
        ownerType: s.ownerType as ShopOwnerType,
        ownerId: s.ownerId,
        name: s.name ?? (u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—'),
        avatar: u?.avatar ?? null,
      };
    });
  }

  // ============================================================
  // Showcases
  // ============================================================

  async createShowcase(viewerId: string, data: CreateShowcaseRequest): Promise<ShowcaseDto> {
    const { ownerType, ownerId } = this.resolveOwner(viewerId);
    const shop = await this.getOrCreateShop(ownerType, ownerId);
    if (!(await this.canManageShop(viewerId, shop))) throw new ForbiddenException('Нет прав на этот магазин');
    const count = await this.db.showcase.count({ where: { shopId: shop.id } });
    if (count >= SHOP_LIMITS.maxShowcases) throw new BadRequestException('Достигнут лимит витрин');
    // Create the showcase AND its parent pointer atomically, so a transient projection failure
    // can't leave a showcase that managers/viewers can never reach.
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.showcase.create({
        data: { shopId: shop.id, name: data.name.trim(), icon: data.icon ?? null, sortOrder: count },
      });
      await this.access.grant(
        { resourceType: 'showcase', resourceId: created.id, relation: 'parent', subjectType: 'shop', subjectId: shop.id },
        tx,
      );
      return created;
    });
    return this.serializeShowcase(row, 0, []);
  }

  async updateShowcase(viewerId: string, id: string, data: UpdateShowcaseRequest): Promise<ShowcaseDto> {
    await this.loadShowcaseManageable(viewerId, id);
    const updated = await this.db.showcase.update({
      where: { id },
      data: {
        name: data.name?.trim() ?? undefined,
        icon: data.icon === undefined ? undefined : data.icon,
        sortOrder: data.sortOrder ?? undefined,
      },
    });
    const count = await this.db.listing.count({ where: { showcaseId: id, status: 'active' } });
    return this.serializeShowcase(updated, count, await this.loadShares(id));
  }

  async deleteShowcase(viewerId: string, id: string): Promise<void> {
    await this.loadShowcaseManageable(viewerId, id);
    // Delete the showcase AND drop all its engine edges (parent, shares, staff) atomically.
    await this.db.$transaction(async (tx) => {
      await tx.showcase.delete({ where: { id } }); // cascades listings
      await this.access.revokeResource('showcase', id, tx);
    });
  }

  // ---- Sharing (tuples are the source of truth) ----
  async shareShowcase(viewerId: string, id: string, data: ShareShowcaseRequest): Promise<ShowcaseShareDto[]> {
    const showcase = await this.loadShowcaseManageable(viewerId, id);
    const shop = await this.db.shop.findUnique({ where: { id: showcase.shopId } });
    await this.assertSharePrincipal(shop!, data);
    if (data.principalType === 'user') {
      await this.access.grant({ resourceType: 'showcase', resourceId: id, relation: 'viewer', subjectType: 'user', subjectId: data.principalId });
    } else {
      await this.access.grant({ resourceType: 'showcase', resourceId: id, relation: 'viewer', subjectType: 'circle', subjectId: data.principalId, subjectRelation: 'member' });
    }
    return this.loadShares(id);
  }

  async unshareShowcase(viewerId: string, id: string, principalType: string, principalId: string): Promise<ShowcaseShareDto[]> {
    await this.loadShowcaseManageable(viewerId, id);
    await this.access.revoke({
      resourceType: 'showcase',
      resourceId: id,
      relation: 'viewer',
      subjectType: principalType,
      subjectId: principalId,
      subjectRelation: principalType === 'circle' ? 'member' : '',
    });
    return this.loadShares(id);
  }

  // ============================================================
  // Listings
  // ============================================================

  /**
   * Currencies the viewer can price listings in — their own + currencies issued by people in their
   * окружение (contacts). Feeds the multi-currency price editor (own currency first). Phase 5.
   */
  async accessibleCurrencies(viewerId: string): Promise<AccessibleCurrencyDto[]> {
    const { ownerType, ownerId } = this.resolveOwner(viewerId);
    const currencies = await this.ownerPriceableCurrencies(ownerType, ownerId);
    const issuers = await this.userMinis(currencies.map((c) => c.issuerId));
    return currencies
      .map((c) => {
        const u = issuers.get(c.issuerId);
        return {
          id: c.id,
          name: c.name,
          icon: c.icon,
          scale: c.scale,
          issuerId: c.issuerId,
          issuerName:
            c.issuerId === ownerId ? 'Моя валюта' : u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—',
          isOwn: c.issuerId === ownerId,
        };
      })
      .sort((a, b) => (a.isOwn === b.isOwn ? a.name.localeCompare(b.name, 'ru') : a.isOwn ? -1 : 1));
  }

  async listListings(viewerId: string, showcaseId: string): Promise<ListingDto[]> {
    const showcase = await this.db.showcase.findUnique({ where: { id: showcaseId } });
    if (!showcase) throw new NotFoundException('Витрина не найдена');
    const shop = await this.db.shop.findUnique({ where: { id: showcase.shopId } });
    const canManage = await this.canManageShop(viewerId, shop!);
    if (!canManage && !(await this.canViewShowcase(viewerId, showcaseId))) {
      throw new ForbiddenException('Нет доступа к витрине');
    }
    const rows = await this.db.listing.findMany({
      where: { showcaseId, ...(canManage ? {} : { status: 'active' }) },
      include: LISTING_INCLUDE,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const currencies = await this.currencyMap(rows.flatMap((r) => r.prices.map((p) => p.currencyId)));
    const campaignByListing = await this.activeCampaigns(rows.filter((r) => r.crowdfunding).map((r) => r.id), viewerId);
    // Обложки одним батчем (без N+1) — первое фото галереи каждого лота
    const galleries = await this.files.listLinked('listing', rows.map((r) => r.id), 'gallery');
    return rows.map((r) =>
      this.serializeListing(r, currencies, campaignByListing.get(r.id) ?? null, this.coverUrlFrom(galleries.get(r.id))),
    );
  }

  // ============================================================
  // Галерея лота (движок файлов: FileLink refType='listing' role='gallery')
  // ============================================================

  async getListingImages(viewerId: string, listingId: string): Promise<FileDto[]> {
    const listing = await this.db.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new NotFoundException('Товар не найден');
    const canManage = await this.access.can(this.user(viewerId), 'showcase.manage', listing.showcaseId);
    if (!canManage && !(await this.canViewShowcase(viewerId, listing.showcaseId))) {
      throw new ForbiddenException('Нет доступа к витрине');
    }
    return (await this.files.listLinked('listing', [listingId], 'gallery')).get(listingId) ?? [];
  }

  async attachListingImage(viewerId: string, listingId: string, fileId: string): Promise<FileDto[]> {
    const listing = await this.db.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new NotFoundException('Товар не найден');
    await this.loadShowcaseManageable(viewerId, listing.showcaseId);
    await this.files.getOwnedReadyFiles(viewerId, [fileId]); // ready + uploader (профиль enforce'ит движок)
    // Лимит + линковка под блокировкой строки лота: конкурентные attach'и сериализуются
    // (иначе оба читают count=9<10 и оба линкуют → 11 фото).
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "listings" WHERE id = ${listingId} FOR UPDATE`;
      // Через API движка (countLinkedInTx), не прямым чтением file_links — carve-out закрыт.
      const count = await this.files.countLinkedInTx(tx, 'listing', listingId, 'gallery');
      if (count >= SHOP_LIMITS.maxListingImages) {
        throw new BadRequestException(`Не больше ${SHOP_LIMITS.maxListingImages} фото у товара`);
      }
      await this.files.linkManyInTx(tx, viewerId, [fileId], 'listing', listingId, 'gallery');
    });
    return (await this.files.listLinked('listing', [listingId], 'gallery')).get(listingId) ?? [];
  }

  async removeListingImage(viewerId: string, listingId: string, fileId: string): Promise<void> {
    const listing = await this.db.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new NotFoundException('Товар не найден');
    await this.loadShowcaseManageable(viewerId, listing.showcaseId);
    // Отвязать эту связь и прибрать сироту (системный soft-delete: удаляющий соуправляющий
    // мог быть не загрузившим — Forbidden больше не роняет уборку).
    await this.files.unlinkAndReap(viewerId, fileId, 'listing', listingId, 'gallery');
  }

  /** Live crowdfunding campaigns (funding|pending) for the given listings → progress + viewer's pledge. */
  private async activeCampaigns(listingIds: string[], viewerId: string): Promise<Map<string, ListingDto['campaign']>> {
    const out = new Map<string, ListingDto['campaign']>();
    if (listingIds.length === 0) return out;
    const campaigns = await this.db.order.findMany({
      where: { listingId: { in: listingIds }, crowdfunding: true, status: { in: ['funding', 'pending'] } },
      include: { contributions: true },
    });
    for (const c of campaigns) {
      if (!c.listingId) continue;
      const raised = new Map<string, bigint>();
      for (const x of c.contributions) raised.set(x.currencyId, (raised.get(x.currencyId) ?? 0n) + x.amount);
      out.set(c.listingId, {
        orderId: c.id,
        status: c.status as 'funding' | 'pending',
        raised: [...raised.entries()].map(([currencyId, amount]) => ({ currencyId, amount: Number(amount) })),
        myContribution: c.contributions
          .filter((x) => x.contributorId === viewerId)
          .map((x) => ({ currencyId: x.currencyId, amount: Number(x.amount) })),
      });
    }
    return out;
  }

  async createListing(viewerId: string, data: CreateListingRequest): Promise<ListingDto> {
    const showcase = await this.loadShowcaseManageable(viewerId, data.showcaseId);
    const shop = await this.db.shop.findUnique({ where: { id: showcase.shopId } });
    const lines = await this.resolvePrices(shop!, data);
    if (!lines) throw new BadRequestException('Укажите цену товара');
    const count = await this.db.listing.count({ where: { showcaseId: data.showcaseId } });
    if (count >= SHOP_LIMITS.maxListingsPerShowcase) throw new BadRequestException('Достигнут лимит товаров в витрине');

    const row = await this.db.listing.create({
      data: {
        showcaseId: data.showcaseId,
        title: data.title.trim(),
        description: data.description ?? null,
        icon: data.icon ?? null,
        itemType: data.itemType ?? 'material',
        withTask: data.withTask ?? false,
        taskDays: data.withTask ? data.taskDays ?? null : null,
        crowdfunding: data.crowdfunding ?? false,
        stockLimit: data.stockLimit ?? null,
        availableFrom: data.availableFrom ? new Date(data.availableFrom) : null,
        availableUntil: data.availableUntil ? new Date(data.availableUntil) : null,
        discountPercent: data.discountPercent ?? null,
        discountUntil: data.discountUntil ? new Date(data.discountUntil) : null,
        sortOrder: count,
        prices: { create: lines.map((l) => ({ currencyId: l.currencyId, amount: BigInt(l.amount) })) },
      },
      include: LISTING_INCLUDE,
    });
    return this.serializeListing(row, await this.currencyMap(lines.map((l) => l.currencyId)));
  }

  async updateListing(viewerId: string, id: string, data: UpdateListingRequest): Promise<ListingDto> {
    const existing = await this.db.listing.findUnique({ where: { id }, include: { showcase: true } });
    if (!existing) throw new NotFoundException('Товар не найден');
    await this.loadShowcaseManageable(viewerId, existing.showcaseId);
    const shop = await this.db.shop.findUnique({ where: { id: existing.showcase.shopId } });
    // Resolve the new price (if any) BEFORE the write — read-only validation that the currencies
    // are the owner's own or an окружение contact's. A new price REPLACES the whole price.
    const lines = await this.resolvePrices(shop!, data);

    await this.db.$transaction(async (tx) => {
      await tx.listing.update({
        where: { id },
        data: {
          title: data.title?.trim() ?? undefined,
          description: data.description === undefined ? undefined : data.description,
          icon: data.icon === undefined ? undefined : data.icon,
          itemType: data.itemType ?? undefined,
          withTask: data.withTask ?? undefined,
          taskDays: data.taskDays === undefined ? undefined : data.taskDays,
          crowdfunding: data.crowdfunding ?? undefined,
          stockLimit: data.stockLimit === undefined ? undefined : data.stockLimit,
          availableFrom: data.availableFrom === undefined ? undefined : data.availableFrom ? new Date(data.availableFrom) : null,
          availableUntil: data.availableUntil === undefined ? undefined : data.availableUntil ? new Date(data.availableUntil) : null,
          discountPercent: data.discountPercent === undefined ? undefined : data.discountPercent,
          discountUntil: data.discountUntil === undefined ? undefined : data.discountUntil ? new Date(data.discountUntil) : null,
          status: data.status ?? undefined,
          sortOrder: data.sortOrder ?? undefined,
        },
      });
      if (lines) {
        await tx.listingPrice.deleteMany({ where: { listingId: id } });
        await tx.listingPrice.createMany({
          data: lines.map((l) => ({ listingId: id, currencyId: l.currencyId, amount: BigInt(l.amount) })),
        });
      }
    });
    const row = await this.db.listing.findUnique({ where: { id }, include: LISTING_INCLUDE });
    const gallery = (await this.files.listLinked('listing', [id], 'gallery')).get(id);
    return this.serializeListing(
      row!,
      await this.currencyMap(row!.prices.map((p) => p.currencyId)),
      null,
      this.coverUrlFrom(gallery),
    );
  }

  async deleteListing(viewerId: string, id: string): Promise<void> {
    const existing = await this.db.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Товар не найден');
    await this.loadShowcaseManageable(viewerId, existing.showcaseId);
    const active = await this.db.order.count({ where: { listingId: id, status: { in: ['funding', 'pending', 'confirmed'] } } });
    if (active > 0) throw new BadRequestException('Нельзя удалить товар с активным заказом или сбором');
    await this.db.listing.delete({ where: { id } }); // settled/cancelled orders keep history (listingId → null)
    // Фото галереи (полиморфный FileLink не каскадится) — отвязать и прибрать сироты,
    // иначе публичные картинки удалённого лота вечно висят в квоте и раздаются по ссылке.
    await this.files.unlinkAllForRef('listing', id, 'gallery').catch(() => undefined);
  }

  // ============================================================
  // Orders (Phase 3 — purchase with escrow; money via the wallet engine, refType='order')
  // ============================================================

  /**
   * Place an order: freeze the price in escrow (buyer → shop owner). The buyer needs `showcase.view`
   * and enough of the OWNER's currency (the freeze throws → rolls back otherwise). Phase 3 sells only
   * "instant" items (non-material, or material WITHOUT a task); material «с задачей» is Phase 4.
   */
  async buy(buyerId: string, listingId: string): Promise<OrderDto> {
    const listing = await this.db.listing.findUnique({ where: { id: listingId }, include: { prices: true, showcase: true } });
    if (!listing) throw new NotFoundException('Товар не найден');
    if (listing.crowdfunding) throw new BadRequestException('Это совместная покупка — используйте «Скинуться»');
    this.assertSellable(listing);
    if (!(await this.access.can(this.user(buyerId), 'showcase.view', listing.showcaseId))) {
      throw new ForbiddenException('Нет доступа к этому товару');
    }
    const shop = await this.db.shop.findUnique({ where: { id: listing.showcase.shopId } });
    if (!shop) throw new NotFoundException('Магазин не найден');
    if (shop.ownerType === 'workspace' && listing.withTask) {
      throw new BadRequestException('Товар «с задачей» в магазине компании пока недоступен');
    }
    const sellerId = shop.ownerId; // user id, or workspace id for a company shop (paid into the treasury)
    const sellerType = shop.ownerType as string; // 'user' | 'workspace'
    if (sellerId === buyerId) throw new BadRequestException('Нельзя купить в собственном магазине');
    const prices = listing.prices;
    if (prices.length === 0) throw new BadRequestException('У товара не указана цена');
    // Every price currency must still be active — a deleted currency makes the lot unbuyable.
    const activeIds = new Set(
      (
        await this.db.currency.findMany({
          where: { id: { in: prices.map((p) => p.currencyId) }, status: 'active' },
          select: { id: true },
        })
      ).map((c) => c.id),
    );
    if (prices.some((p) => !activeIds.has(p.currencyId))) {
      throw new BadRequestException('Цена содержит недоступную валюту — покупка невозможна');
    }

    // All-or-nothing: reserve a unit of stock + snapshot the (possibly discounted) price + freeze one
    // escrow leg per currency in ONE transaction. Sold out → reserveStock throws; lacking ANY currency
    // → the freeze throws; either way the whole order rolls back (incl. the stock reservation).
    const eff = this.effectivePrices(listing);
    const order = await this.db.$transaction(async (tx) => {
      await this.reserveStock(tx, listing.id);
      const created = await tx.order.create({
        data: {
          listingId: listing.id,
          titleSnapshot: listing.title,
          showcaseId: listing.showcaseId,
          shopId: shop.id,
          buyerId,
          sellerId,
          status: 'pending',
          itemType: listing.itemType,
          withTask: listing.withTask,
          taskDays: listing.taskDays,
          prices: { create: eff.map((p) => ({ currencyId: p.currencyId, amount: p.amount })) },
        },
        include: ORDER_INCLUDE,
      });
      for (const p of eff) {
        await this.escrow.fund(tx, {
          refType: 'order',
          refId: created.id,
          payerUserId: buyerId,
          beneficiaryUserId: sellerId,
          beneficiaryType: sellerType,
          currencyId: p.currencyId,
          amount: Number(p.amount),
        });
      }
      return created;
    });

    // Project order roles SYNCHRONOUSLY so the order rich-card / chat is accessible
    // immediately (the shop.order.* listener is an idempotent safety net, not the source).
    await this.accessProjection.resyncOrderRoles(order.id);
    this.notifications.emitEvent('shop.order.placed', { orderId: order.id, sellerId, buyerId, title: order.titleSnapshot }, 'shop');
    return this.serializeOrder(order, await this.currencyMap(order.prices.map((p) => p.currencyId)));
  }

  // ============================================================
  // Crowdfunding (Phase 6) — one campaign (Order, status 'funding') funded by many pledges
  // ============================================================

  /**
   * Pledge toward a crowdfunding campaign. Finds-or-creates the listing's single active campaign,
   * then freezes one escrow leg per pledged currency (payer = contributor → beneficiary = owner) in
   * ONE transaction — all-or-nothing (lacking ANY currency → the freeze throws → rollback). Each line
   * is capped to the remaining goal for that currency. When EVERY goal currency is filled the campaign
   * flips to 'pending' (awaiting the owner's confirm). One active pledge per contributor (withdraw to
   * change). A contributor needs `showcase.view`, same as buying.
   */
  async contribute(contributorId: string, listingId: string, lines: ContributionLine[]): Promise<OrderDto> {
    const listing = await this.db.listing.findUnique({ where: { id: listingId }, include: { prices: true, showcase: true } });
    if (!listing) throw new NotFoundException('Товар не найден');
    if (!listing.crowdfunding) throw new BadRequestException('Этот лот не краудфандинговый — используйте «Купить»');
    this.assertSellable(listing);
    if (!(await this.access.can(this.user(contributorId), 'showcase.view', listing.showcaseId))) {
      throw new ForbiddenException('Нет доступа к этому товару');
    }
    const shop = await this.db.shop.findUnique({ where: { id: listing.showcase.shopId } });
    if (!shop) throw new NotFoundException('Магазин не найден');
    if (shop.ownerType === 'workspace' && listing.withTask) {
      throw new BadRequestException('Сбор «с задачей» в магазине компании пока недоступен');
    }
    const sellerId = shop.ownerId;
    const sellerType = shop.ownerType as string;
    if (sellerId === contributorId) throw new BadRequestException('Нельзя скидываться в собственном магазине');

    const goalCurrencies = new Set(listing.prices.map((p) => p.currencyId));
    if (goalCurrencies.size === 0) throw new BadRequestException('У товара не указана цена');
    const activeIds = new Set(
      (
        await this.db.currency.findMany({
          where: { id: { in: listing.prices.map((p) => p.currencyId) }, status: 'active' },
          select: { id: true },
        })
      ).map((c) => c.id),
    );
    for (const line of lines) {
      if (!goalCurrencies.has(line.currencyId)) throw new BadRequestException('Вкладывать можно только в валюты цены лота');
      if (!activeIds.has(line.currencyId)) throw new BadRequestException('Цена содержит недоступную валюту');
    }

    const campaignId = await this.getOrCreateCampaign(listing, shop.id, sellerId, contributorId);

    const order = await this.db.$transaction(async (tx) => {
      // Serialise concurrent pledges on this campaign so two contributors can't overfill a currency.
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${campaignId} FOR UPDATE`;
      const campaign = await tx.order.findUnique({ where: { id: campaignId }, include: ORDER_INCLUDE });
      if (!campaign || campaign.status !== 'funding') throw new BadRequestException('Кампания уже собрана или закрыта');
      if (campaign.contributions.some((c) => c.contributorId === contributorId)) {
        throw new BadRequestException('Вы уже вложились — отзовите свой вклад, чтобы изменить');
      }
      // The goal is the campaign's SNAPSHOTTED price (a FOMO discount is locked at creation time).
      const goal = new Map(campaign.prices.map((p) => [p.currencyId, p.amount] as const));
      const raised = new Map<string, bigint>();
      for (const c of campaign.contributions) raised.set(c.currencyId, (raised.get(c.currencyId) ?? 0n) + c.amount);

      for (const line of lines) {
        const goalAmt = goal.get(line.currencyId) ?? 0n;
        const have = raised.get(line.currencyId) ?? 0n;
        const remaining = goalAmt - have;
        if (BigInt(line.amount) > remaining) {
          throw new BadRequestException(`Вклад превышает остаток по валюте (осталось ${remaining})`);
        }
        await tx.orderContribution.create({
          data: { orderId: campaignId, contributorId, currencyId: line.currencyId, amount: BigInt(line.amount) },
        });
        await this.escrow.fund(tx, {
          refType: 'order',
          refId: campaignId,
          payerUserId: contributorId,
          beneficiaryUserId: sellerId,
          beneficiaryType: sellerType,
          currencyId: line.currencyId,
          amount: line.amount,
        });
        raised.set(line.currencyId, have + BigInt(line.amount));
      }

      const funded = [...goal.entries()].every(([cur, amt]) => (raised.get(cur) ?? 0n) >= amt);
      if (funded) await tx.order.update({ where: { id: campaignId }, data: { status: 'pending' } });
      return (await tx.order.findUnique({ where: { id: campaignId }, include: ORDER_INCLUDE }))!;
    });

    // Sync roles now so the campaign chat/card includes this contributor immediately.
    await this.accessProjection.resyncOrderRoles(campaignId);
    this.notifications.emitEvent('shop.order.placed', { orderId: campaignId, sellerId, buyerId: contributorId, title: order.titleSnapshot }, 'shop');
    if (order.status === 'pending') {
      this.notifications.emitEvent('shop.order.funded', { orderId: campaignId, sellerId, title: order.titleSnapshot }, 'shop');
    }
    return this.serializeOrder(order, await this.currencyMap(order.prices.map((p) => p.currencyId)), { viewerId: contributorId });
  }

  /** Withdraw my pledge from a still-collecting campaign → release my legs. Empties → campaign cancelled. */
  async withdraw(contributorId: string, orderId: string): Promise<OrderDto> {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: { id: true, crowdfunding: true, sellerId: true, titleSnapshot: true },
    });
    if (!order || !order.crowdfunding) throw new NotFoundException('Кампания не найдена');
    await this.db.$transaction(async (tx) => {
      // Same campaign row lock as contribute(): a withdraw can't race the goal-reaching pledge
      // (otherwise the campaign flips to 'pending' while a leg is being released → owner confirms
      // an under-funded campaign).
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const fresh = await tx.order.findUnique({ where: { id: orderId }, include: { contributions: true } });
      if (!fresh || fresh.status !== 'funding') {
        throw new BadRequestException('Кампания уже собрана или закрыта — отозвать нельзя');
      }
      const mine = fresh.contributions.filter((c) => c.contributorId === contributorId);
      if (mine.length === 0) throw new BadRequestException('Вы не вкладывались в эту кампанию');
      const emptyAfter = fresh.contributions.length === mine.length;
      await this.escrow.release(tx, { refType: 'order', refId: orderId, payerUserId: contributorId });
      await tx.orderContribution.deleteMany({ where: { orderId, contributorId } });
      if (emptyAfter) {
        await tx.order.update({ where: { id: orderId }, data: { status: 'cancelled', closedAt: new Date() } });
        await this.restoreStock(tx, fresh.listingId);
      }
    });
    // Contributor removed → re-project roles (drops their order.view) immediately.
    await this.accessProjection.resyncOrderRoles(orderId);
    this.notifications.emitEvent('shop.order.cancelled', { orderId, sellerId: order.sellerId, title: order.titleSnapshot }, 'shop');
    return this.reloadOrder(orderId, contributorId);
  }

  /** Order / campaign detail (progress per currency + contributors). Party or manager only. */
  async getOrderDetail(viewerId: string, orderId: string): Promise<OrderDto> {
    const order = await this.db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Заказ не найден');
    const isParty = order.buyerId === viewerId || order.contributions.some((c) => c.contributorId === viewerId);
    const canManage = await this.access.can(this.user(viewerId), 'showcase.manage', order.showcaseId);
    if (!isParty && !canManage) throw new ForbiddenException('Нет доступа к заказу');
    const contributorNames = await this.userMinis(order.contributions.map((c) => c.contributorId));
    return this.serializeOrder(order, await this.currencyMap(order.prices.map((p) => p.currencyId)), { viewerId, contributorNames });
  }

  /** Find the listing's single active campaign, or open a new one (initiator = first contributor). */
  private async getOrCreateCampaign(
    listing: Prisma.ListingGetPayload<{ include: { prices: true } }>,
    shopId: string,
    sellerId: string,
    initiatorId: string,
  ): Promise<string> {
    const active = await this.db.order.findFirst({
      where: { listingId: listing.id, crowdfunding: true, status: { in: ['funding', 'pending'] } },
      select: { id: true, status: true },
    });
    if (active) {
      if (active.status === 'pending') throw new BadRequestException('Кампания уже собрана — ждёт подтверждения владельцем');
      return active.id;
    }
    try {
      // Snapshot the (possibly discounted) goal, reserve a unit of stock, stamp the deadline — all
      // atomic so a sold-out lot can't open a campaign.
      const eff = this.effectivePrices(listing);
      const created = await this.db.$transaction(async (tx) => {
        await this.reserveStock(tx, listing.id);
        return tx.order.create({
          data: {
            listingId: listing.id,
            titleSnapshot: listing.title,
            showcaseId: listing.showcaseId,
            shopId,
            buyerId: initiatorId,
            sellerId,
            status: 'funding',
            crowdfunding: true,
            itemType: listing.itemType,
            withTask: listing.withTask,
            taskDays: listing.taskDays,
            expiresAt: listing.availableUntil ?? null,
            prices: { create: eff.map((p) => ({ currencyId: p.currencyId, amount: p.amount })) },
          },
          select: { id: true },
        });
      });
      return created.id;
    } catch (err) {
      // Lost a race to another initiator (partial-unique on active campaign per listing) → reuse theirs.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const e = await this.db.order.findFirst({
          where: { listingId: listing.id, crowdfunding: true, status: { in: ['funding', 'pending'] } },
          select: { id: true },
        });
        if (e) return e.id;
      }
      throw err;
    }
  }

  /**
   * Owner / co-manager confirms a fully-funded order (status 'pending'). Settlement by item type:
   *  - material «с задачей»: DON'T capture — create a fulfilment Task (Постановщик = recipient,
   *    Исполнитель = owner, reward 0; the money is held by the ORDER escrow). Order → confirmed;
   *    it settles when the recipient accepts the delivery (task.completed → onFulfillmentDone).
   *  - else (instant): capture now → settled. Non-material «с задачей» additionally gets a shared
   *    calendar event (paid up front; the event is a scheduling/reminder, not a money gate).
   * For a crowdfunding campaign the recipient/Постановщик is the TOP contributor, the rest become
   * observers (task) or participants (event); a single buyer is both for a normal order.
   */
  async confirmOrder(actorId: string, orderId: string): Promise<OrderDto> {
    const order = await this.loadManageableOrder(actorId, orderId);
    if (order.status !== 'pending') {
      throw new BadRequestException(
        order.crowdfunding && order.status === 'funding' ? 'Кампания ещё собирает взносы' : 'Заказ уже обработан',
      );
    }
    const parties = this.fulfilmentParties(order);

    if (order.itemType === 'material' && order.withTask) {
      // Claim FIRST (status-guarded): a concurrent confirm can't create a SECOND fulfilment task.
      const claimed = await this.db.order.updateMany({
        where: { id: orderId, status: 'pending' },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
      if (claimed.count === 0) throw new BadRequestException('Заказ уже обработан');
      try {
        const due = new Date(Date.now() + (order.taskDays ?? 7) * 86_400_000);
        const task = await this.tasks.createTask(
          parties.recipientId,
          {
            title: `Выдать: ${order.titleSnapshot}`,
            executorId: order.sellerId,
            observerIds: parties.observerIds.length ? parties.observerIds : undefined,
            dueDate: due.toISOString(),
            coinReward: 0,
          },
          // Contributors aren't necessarily in the recipient's окружение — this is a system task whose
          // participants were already authorised by their contributions.
          { skipEnvironmentChecks: true },
        );
        await this.db.order.update({ where: { id: orderId }, data: { taskId: task.id } });
      } catch (err) {
        // Task creation failed → un-claim so the owner can confirm again (no orphaned 'confirmed').
        await this.db.order
          .updateMany({
            where: { id: orderId, status: 'confirmed', taskId: null },
            data: { status: 'pending', confirmedAt: null },
          })
          .catch(() => {});
        throw err;
      }
      this.notifications.emitEvent('shop.order.confirmed', { orderId, buyerId: order.buyerId, title: order.titleSnapshot }, 'shop');
      return this.reloadOrder(orderId);
    }

    await this.db.$transaction(async (tx) => {
      // Status-guarded claim in the SAME tx as the capture → a concurrent confirm can't double-settle.
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: 'pending' },
        data: { status: 'settled', confirmedAt: new Date(), closedAt: new Date() },
      });
      if (claimed.count === 0) throw new BadRequestException('Заказ уже обработан');
      await this.escrow.capture(tx, { refType: 'order', refId: orderId });
    });
    if (order.itemType === 'nonmaterial' && order.withTask) {
      const start = new Date(Date.now() + (order.taskDays ?? 7) * 86_400_000);
      const end = new Date(start.getTime() + 3_600_000);
      try {
        const ev = await this.calendar.createEvent(order.sellerId, {
          title: order.titleSnapshot,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          participantUserIds: parties.participantIds,
        });
        await this.db.order.update({ where: { id: orderId }, data: { eventId: ev.id } });
      } catch {
        /* the event is a non-critical reminder; settlement already succeeded */
      }
    }
    await this.markWishFulfilledIfSourced(order.listingId);
    this.notifications.emitEvent('shop.order.confirmed', { orderId, buyerId: order.buyerId, title: order.titleSnapshot }, 'shop');
    return this.reloadOrder(orderId);
  }

  /**
   * Who fulfils/receives an order. Normal order → the single buyer is recipient & sole participant.
   * Crowdfunding → the TOP contributor (largest total pledged, ties → earliest) is the recipient /
   * Постановщик; everyone else who pledged becomes an observer (task) / participant (event).
   * NB: personal coins have no exchange rate, so "largest" is the naive sum of pledged amounts.
   */
  private fulfilmentParties(order: OrderWithDetail): { recipientId: string; observerIds: string[]; participantIds: string[] } {
    if (!order.crowdfunding) {
      return { recipientId: order.buyerId, observerIds: [], participantIds: [order.buyerId] };
    }
    const totals = new Map<string, { total: number; first: number }>();
    for (const c of order.contributions) {
      const cur = totals.get(c.contributorId) ?? { total: 0, first: c.createdAt.getTime() };
      cur.total += Number(c.amount);
      cur.first = Math.min(cur.first, c.createdAt.getTime());
      totals.set(c.contributorId, cur);
    }
    const ranked = [...totals.entries()]
      .filter(([uid]) => uid !== order.sellerId)
      .sort((a, b) => b[1].total - a[1].total || a[1].first - b[1].first)
      .map(([uid]) => uid);
    const recipientId = ranked[0] ?? order.buyerId;
    return {
      recipientId,
      observerIds: ranked.filter((uid) => uid !== recipientId),
      participantIds: ranked,
    };
  }

  /** Owner / co-manager rejects → refund everyone (unfreeze). Works on a funding or funded campaign too. */
  async rejectOrder(actorId: string, orderId: string): Promise<OrderDto> {
    const order = await this.loadManageableOrder(actorId, orderId);
    if (!['pending', 'funding'].includes(order.status)) throw new BadRequestException('Заказ уже обработан');
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: { in: ['pending', 'funding'] } },
        data: { status: 'rejected', closedAt: new Date() },
      });
      if (claimed.count === 0) throw new BadRequestException('Заказ уже обработан');
      await this.escrow.releaseAll(tx, { refType: 'order', refId: orderId });
      await this.restoreStock(tx, order.listingId);
    });
    this.notifications.emitEvent('shop.order.rejected', { orderId, buyerId: order.buyerId, title: order.titleSnapshot }, 'shop');
    return this.reloadOrder(orderId);
  }

  /** Buyer cancels their own still-pending order → refund (unfreeze). Crowdfunding uses withdraw instead. */
  async cancelOrder(buyerId: string, orderId: string): Promise<OrderDto> {
    const order = await this.db.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Заказ не найден');
    if (order.crowdfunding) throw new BadRequestException('Это совместная кампания — отзовите свой вклад');
    if (order.buyerId !== buyerId) throw new ForbiddenException('Это не ваш заказ');
    if (order.status !== 'pending') throw new BadRequestException('Заказ уже обработан');
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: 'pending' },
        data: { status: 'cancelled', closedAt: new Date() },
      });
      if (claimed.count === 0) throw new BadRequestException('Заказ уже обработан');
      await this.escrow.releaseAll(tx, { refType: 'order', refId: orderId });
      await this.restoreStock(tx, order.listingId);
    });
    this.notifications.emitEvent('shop.order.cancelled', { orderId, sellerId: order.sellerId, title: order.titleSnapshot }, 'shop');
    return this.reloadOrder(orderId);
  }

  /**
   * Owner / co-manager refunds a CONFIRMED (in-fulfilment) order — the seller backs out. Releases
   * the hold and cancels the fulfilment task. The BUYER cannot cancel once it's in fulfilment.
   */
  async refundOrder(actorId: string, orderId: string): Promise<OrderDto> {
    const order = await this.loadManageableOrder(actorId, orderId);
    if (order.status !== 'confirmed') throw new BadRequestException('Вернуть можно только заказ в работе');
    await this.db.$transaction(async (tx) => {
      // Status-guarded: a refund racing the fulfilment settle (onFulfillmentDone) — one wins.
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: 'confirmed' },
        data: { status: 'refunded', closedAt: new Date() },
      });
      if (claimed.count === 0) throw new BadRequestException('Вернуть можно только заказ в работе');
      await this.escrow.releaseAll(tx, { refType: 'order', refId: orderId });
      // Отмена задачи-исполнения — через TasksService (статус + хроника task.cancelled),
      // а не прямым updateMany мимо хроники: движок владеет записями задачи.
      if (order.taskId) await this.tasks.cancelFulfilmentTaskTrusted(tx, order.taskId, actorId);
      await this.restoreStock(tx, order.listingId);
    });
    this.notifications.emitEvent('shop.order.rejected', { orderId, buyerId: order.buyerId, title: order.titleSnapshot }, 'shop');
    return this.reloadOrder(orderId);
  }

  /**
   * The buyer accepted the fulfilment task (task.completed) → capture the order's escrow → settled.
   * Called by ShopEventsListener for EVERY task.completed; no-ops unless a confirmed order links it.
   */
  async onFulfillmentDone(taskId: string): Promise<void> {
    const order = await this.db.order.findFirst({ where: { taskId, status: 'confirmed' } });
    if (!order) return;
    const settled = await this.db.$transaction(async (tx) => {
      // Status-guarded: the sync call (TasksService), the bus listener and the cron sweep can all
      // race here — exactly one claims the order, the rest no-op.
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: 'confirmed' },
        data: { status: 'settled', closedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      await this.escrow.capture(tx, { refType: 'order', refId: order.id });
      return true;
    });
    if (!settled) return;
    await this.markWishFulfilledIfSourced(order.listingId);
    this.notifications.emitEvent('shop.order.confirmed', { orderId: order.id, buyerId: order.buyerId, title: order.titleSnapshot }, 'shop');
  }

  /**
   * Safety net for «с задачей» settlement: if the task.completed signal was lost (crash between the
   * task tx and the sync settle, at-most-once bus), confirmed orders whose fulfilment task is already
   * done are settled here by the ShopCron sweep. Idempotent — onFulfillmentDone is status-guarded.
   */
  async settleCompletedFulfilments(): Promise<number> {
    const stuck = await this.db.order.findMany({
      where: { status: 'confirmed', taskId: { not: null } },
      select: { taskId: true },
      take: 200,
    });
    if (stuck.length === 0) return 0;
    const doneTasks = await this.db.task.findMany({
      where: { id: { in: stuck.map((o) => o.taskId!) }, status: 'done' },
      select: { id: true },
    });
    let settled = 0;
    for (const t of doneTasks) {
      await this.onFulfillmentDone(t.id);
      settled++;
    }
    return settled;
  }

  // ============================================================
  // Scheduled sweeps (Phase 7) — driven by ShopCron under a Redis lock
  // ============================================================

  /** Archive listings whose availability window has closed (active → archived). Returns the count. */
  async archiveExpiredListings(): Promise<number> {
    const res = await this.db.listing.updateMany({
      where: { status: 'active', availableUntil: { lt: new Date() } },
      data: { status: 'archived' },
    });
    return res.count;
  }

  /** Refund crowdfunding campaigns past their deadline unfilled (release all + cancel + restore stock). */
  async expireCampaigns(): Promise<number> {
    const due = await this.db.order.findMany({
      where: { crowdfunding: true, status: 'funding', expiresAt: { lt: new Date() } },
      select: { id: true, listingId: true, sellerId: true, titleSnapshot: true },
      // Потолок как у остальных кронов: хвост доберёт следующий прогон (каждые 30 мин).
      orderBy: { expiresAt: 'asc' },
      take: 200,
    });
    let expired = 0;
    for (const c of due) {
      const claimed = await this.db.$transaction(async (tx) => {
        // Status-guarded: a final pledge / withdraw / reject racing the sweep — one wins.
        const res = await tx.order.updateMany({
          where: { id: c.id, status: 'funding' },
          data: { status: 'cancelled', closedAt: new Date() },
        });
        if (res.count === 0) return false;
        await this.escrow.releaseAll(tx, { refType: 'order', refId: c.id });
        await this.restoreStock(tx, c.listingId);
        return true;
      });
      if (claimed) {
        this.notifications.emitEvent('shop.order.cancelled', { orderId: c.id, sellerId: c.sellerId, title: c.titleSnapshot }, 'shop');
        expired++;
      }
    }
    return expired;
  }

  /** Orders I placed or contributed to (buyer view — includes crowdfunding campaigns I pledged to). */
  async listMyOrders(buyerId: string): Promise<OrderDto[]> {
    const rows = await this.db.order.findMany({
      where: { OR: [{ buyerId }, { contributions: { some: { contributorId: buyerId } } }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: ORDER_INCLUDE,
    });
    const currencies = await this.currencyMap(rows.flatMap((r) => r.prices.map((p) => p.currencyId)));
    const covers = await this.orderCovers(rows);
    return rows.map((r) =>
      this.serializeOrder(r, currencies, { viewerId: buyerId, listingCoverUrl: covers.get(r.listingId ?? '') ?? null }),
    );
  }

  /** Orders on shops I manage (owner / co-manager view) — to confirm or reject. */
  async listIncomingOrders(viewerId: string): Promise<OrderDto[]> {
    const shopIds = await this.access.listObjects(this.user(viewerId), 'manager', 'shop');
    if (shopIds.length === 0) return [];
    const rows = await this.db.order.findMany({ where: { shopId: { in: shopIds } }, orderBy: { createdAt: 'desc' }, take: 200, include: ORDER_INCLUDE });
    const currencies = await this.currencyMap(rows.flatMap((r) => r.prices.map((p) => p.currencyId)));
    const buyers = await this.userMinis(rows.map((r) => r.buyerId));
    const covers = await this.orderCovers(rows);
    return rows.map((r) => {
      const u = buyers.get(r.buyerId);
      return this.serializeOrder(r, currencies, {
        buyerName: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—',
        listingCoverUrl: covers.get(r.listingId ?? '') ?? null,
      });
    });
  }

  /** Живые обложки лотов для списков заказов (снапшота фото нет — v1) */
  private async orderCovers(rows: Array<{ listingId: string | null }>): Promise<Map<string, string>> {
    const listingIds = [...new Set(rows.map((r) => r.listingId).filter((x): x is string => !!x))];
    const galleries = await this.files.listLinked('listing', listingIds, 'gallery');
    const out = new Map<string, string>();
    for (const [listingId, files] of galleries) {
      const url = this.coverUrlFrom(files);
      if (url) out.set(listingId, url);
    }
    return out;
  }

  private async loadManageableOrder(actorId: string, orderId: string): Promise<OrderWithDetail> {
    const order = await this.db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Заказ не найден');
    if (!(await this.access.can(this.user(actorId), 'showcase.manage', order.showcaseId))) {
      throw new ForbiddenException('Нет прав на этот заказ');
    }
    return order;
  }

  private async reloadOrder(orderId: string, viewerId?: string): Promise<OrderDto> {
    const row = (await this.db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE }))!;
    return this.serializeOrder(row, await this.currencyMap(row.prices.map((p) => p.currencyId)), { viewerId });
  }


  // ============================================================
  // Wishlist (Phase 8) — a user's wants; shared like a showcase; copied into a lot by окружение
  // ============================================================

  /** My wishlist (non-archived items + audience). */
  async listMyWishes(viewerId: string): Promise<{ items: WishItemDto[]; shares: ShowcaseShareDto[] }> {
    const rows = await this.db.wishItem.findMany({
      where: { ownerId: viewerId, status: { not: 'archived' } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map((w) => this.serializeWish(w)), shares: await this.loadWishlistShares(viewerId) };
  }

  async createWish(ownerId: string, data: CreateWishRequest): Promise<WishItemDto> {
    const count = await this.db.wishItem.count({ where: { ownerId } });
    if (count >= SHOP_LIMITS.maxWishItems) throw new BadRequestException('Достигнут лимит хотелок');
    const row = await this.db.wishItem.create({
      data: {
        ownerId,
        title: data.title.trim(),
        description: data.description ?? null,
        icon: data.icon ?? null,
        link: data.link ?? null,
        itemType: data.itemType ?? 'material',
        sortOrder: count,
      },
    });
    return this.serializeWish(row);
  }

  async updateWish(ownerId: string, id: string, data: UpdateWishRequest): Promise<WishItemDto> {
    const wish = await this.db.wishItem.findUnique({ where: { id } });
    if (!wish || wish.ownerId !== ownerId) throw new NotFoundException('Хотелка не найдена');
    const row = await this.db.wishItem.update({
      where: { id },
      data: {
        title: data.title?.trim() ?? undefined,
        description: data.description === undefined ? undefined : data.description,
        icon: data.icon === undefined ? undefined : data.icon,
        link: data.link === undefined ? undefined : data.link,
        itemType: data.itemType ?? undefined,
        status: data.status ?? undefined,
        sortOrder: data.sortOrder ?? undefined,
        fulfilledAt: data.status === 'fulfilled' ? new Date() : undefined,
      },
    });
    return this.serializeWish(row);
  }

  async deleteWish(ownerId: string, id: string): Promise<void> {
    const wish = await this.db.wishItem.findUnique({ where: { id } });
    if (!wish || wish.ownerId !== ownerId) throw new NotFoundException('Хотелка не найдена');
    await this.db.wishItem.delete({ where: { id } });
  }

  /** Owner marks a wish fulfilled (manual; auto-fulfilment happens when a sourced lot settles). */
  async fulfillWish(ownerId: string, id: string): Promise<WishItemDto> {
    const wish = await this.db.wishItem.findUnique({ where: { id } });
    if (!wish || wish.ownerId !== ownerId) throw new NotFoundException('Хотелка не найдена');
    const row = await this.db.wishItem.update({ where: { id }, data: { status: 'fulfilled', fulfilledAt: new Date() } });
    return this.serializeWish(row);
  }

  // ---- Wishlist sharing (engine tuples: wishlist:<owner>#viewer@user | @circle#member) ----
  async shareWishlist(ownerId: string, data: ShareShowcaseRequest): Promise<ShowcaseShareDto[]> {
    if (data.principalType === 'user') {
      await this.assertInEnvironment(ownerId, data.principalId);
      await this.access.grant({ resourceType: 'wishlist', resourceId: ownerId, relation: 'viewer', subjectType: 'user', subjectId: data.principalId });
    } else {
      const circle = await this.db.circle.findUnique({ where: { id: data.principalId }, select: { ownerId: true } });
      if (!circle || circle.ownerId !== ownerId) throw new ForbiddenException('Группа не найдена');
      await this.access.grant({ resourceType: 'wishlist', resourceId: ownerId, relation: 'viewer', subjectType: 'circle', subjectId: data.principalId, subjectRelation: 'member' });
    }
    return this.loadWishlistShares(ownerId);
  }

  async unshareWishlist(ownerId: string, principalType: string, principalId: string): Promise<ShowcaseShareDto[]> {
    await this.access.revoke({
      resourceType: 'wishlist',
      resourceId: ownerId,
      relation: 'viewer',
      subjectType: principalType,
      subjectId: principalId,
      subjectRelation: principalType === 'circle' ? 'member' : '',
    });
    return this.loadWishlistShares(ownerId);
  }

  /** Wishlists shared with me (the switcher). */
  async accessibleWishlists(viewerId: string): Promise<AccessibleWishlistRef[]> {
    const ownerIds = (await this.access.listObjects(this.user(viewerId), 'viewer', 'wishlist')).filter((id) => id !== viewerId);
    if (ownerIds.length === 0) return [];
    const users = await this.userMinis(ownerIds);
    const counts = await this.db.wishItem.groupBy({ by: ['ownerId'], where: { ownerId: { in: ownerIds }, status: 'active' }, _count: { _all: true } });
    const countById = new Map(counts.map((c) => [c.ownerId, c._count._all]));
    return ownerIds.map((oid) => {
      const u = users.get(oid);
      return { ownerId: oid, name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—', avatar: u?.avatar ?? null, itemCount: countById.get(oid) ?? 0 };
    });
  }

  /** Another person's active wishlist — the viewer needs wishlist.view (or be the owner). */
  async wishlistOf(viewerId: string, ownerId: string): Promise<{ ownerName: string; items: WishItemDto[] }> {
    if (viewerId !== ownerId && !(await this.access.can(this.user(viewerId), 'wishlist.view', ownerId))) {
      throw new ForbiddenException('Нет доступа к этому вишлисту');
    }
    const rows = await this.db.wishItem.findMany({ where: { ownerId, status: 'active' }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const u = (await this.userMinis([ownerId])).get(ownerId);
    return { ownerName: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—', items: rows.map((w) => this.serializeWish(w)) };
  }

  /**
   * Copy someone's wish into one of MY showcases as a priced lot. The lot lives in the COPIER's shop
   * (Listing.sourceWishItemId links back so the wish auto-fulfils when the lot settles). itemType is
   * inherited from the wish; price/crowdfunding/limits are the copier's. The target showcase is
   * auto-shared back to the wish owner so they can see the offer.
   */
  async copyWishToShowcase(copierId: string, wishId: string, data: CopyWishRequest): Promise<ListingDto> {
    const wish = await this.db.wishItem.findUnique({ where: { id: wishId } });
    if (!wish) throw new NotFoundException('Хотелка не найдена');
    if (wish.status !== 'active') throw new BadRequestException('Хотелка уже исполнена или в архиве');
    if (wish.ownerId !== copierId && !(await this.access.can(this.user(copierId), 'wishlist.view', wish.ownerId))) {
      throw new ForbiddenException('Нет доступа к этой хотелке');
    }
    const { ownerType, ownerId } = this.resolveOwner(copierId);
    const shop = await this.getOrCreateShop(ownerType, ownerId);
    if (!(await this.canManageShop(copierId, shop))) throw new ForbiddenException('Нет прав на магазин');

    // Target showcase: an existing one I manage, or a new one named after the wish owner.
    let showcaseId: string;
    if (data.showcaseId) {
      const sc = await this.loadShowcaseManageable(copierId, data.showcaseId);
      if (sc.shopId !== shop.id) throw new ForbiddenException('Витрина не из вашего магазина');
      showcaseId = sc.id;
    } else {
      showcaseId = (await this.createShowcase(copierId, { name: data.newShowcaseName!.trim() })).id;
    }

    const lines = await this.resolvePrices(shop, { prices: data.prices });
    if (!lines) throw new BadRequestException('Укажите цену');
    const count = await this.db.listing.count({ where: { showcaseId } });
    if (count >= SHOP_LIMITS.maxListingsPerShowcase) throw new BadRequestException('Достигнут лимит товаров в витрине');

    const row = await this.db.listing.create({
      data: {
        showcaseId,
        title: wish.title,
        description: wish.description,
        icon: wish.icon,
        itemType: wish.itemType,
        withTask: false,
        crowdfunding: data.crowdfunding ?? false,
        stockLimit: data.stockLimit ?? null,
        availableUntil: data.availableUntil ? new Date(data.availableUntil) : null,
        discountPercent: data.discountPercent ?? null,
        discountUntil: data.discountUntil ? new Date(data.discountUntil) : null,
        sourceWishItemId: wish.id,
        sortOrder: count,
        prices: { create: lines.map((l) => ({ currencyId: l.currencyId, amount: BigInt(l.amount) })) },
      },
      include: LISTING_INCLUDE,
    });

    // Show the offer to the wish owner — auto-share this showcase to them (best-effort).
    if (wish.ownerId !== copierId) {
      try {
        await this.access.grant({ resourceType: 'showcase', resourceId: showcaseId, relation: 'viewer', subjectType: 'user', subjectId: wish.ownerId });
      } catch {
        /* owner not in копier's окружение — they can be granted manually */
      }
    }
    return this.serializeListing(row, await this.currencyMap(lines.map((l) => l.currencyId)));
  }

  /** When a settled order's listing was copied from a wish, auto-mark that wish fulfilled. */
  private async markWishFulfilledIfSourced(listingId: string | null): Promise<void> {
    if (!listingId) return;
    const listing = await this.db.listing.findUnique({ where: { id: listingId }, select: { sourceWishItemId: true } });
    if (!listing?.sourceWishItemId) return;
    await this.db.wishItem.updateMany({
      where: { id: listing.sourceWishItemId, status: 'active' },
      data: { status: 'fulfilled', fulfilledAt: new Date() },
    });
  }

  /** Wishlist audience for the owner's UI — read from the engine's viewer tuples. */
  private async loadWishlistShares(ownerId: string): Promise<ShowcaseShareDto[]> {
    const tuples = await this.db.relationTuple.findMany({
      where: { resourceType: 'wishlist', resourceId: ownerId, relation: 'viewer', subjectType: { in: ['user', 'circle'] } },
      select: { subjectType: true, subjectId: true },
    });
    const userIds = tuples.filter((t) => t.subjectType === 'user').map((t) => t.subjectId);
    const circleIds = tuples.filter((t) => t.subjectType === 'circle').map((t) => t.subjectId);
    const users = await this.userMinis(userIds);
    const circles = new Map(
      (await this.db.circle.findMany({ where: { id: { in: circleIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    return tuples.map((t) => {
      if (t.subjectType === 'user') {
        const u = users.get(t.subjectId);
        return { principalType: 'user' as const, principalId: t.subjectId, name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—' };
      }
      return { principalType: 'circle' as const, principalId: t.subjectId, name: circles.get(t.subjectId) ?? 'Группа' };
    });
  }

  private serializeWish(w: Prisma.WishItemGetPayload<object>): WishItemDto {
    return {
      id: w.id,
      ownerId: w.ownerId,
      title: w.title,
      description: w.description,
      icon: w.icon,
      link: w.link,
      itemType: w.itemType as WishItemDto['itemType'],
      status: w.status as WishItemDto['status'],
      sortOrder: w.sortOrder,
      createdAt: w.createdAt.toISOString(),
    };
  }

  // ============================================================
  // Staff (manage capability granted at shop or showcase scope)
  // ============================================================

  async listStaff(viewerId: string): Promise<ShopStaffDto[]> {
    const { ownerType, ownerId } = this.resolveOwner(viewerId);
    const shop = await this.getOrCreateShop(ownerType, ownerId);
    if (!(await this.canManageShop(viewerId, shop))) throw new ForbiddenException('Нет прав на этот магазин');

    const showcases = await this.db.showcase.findMany({ where: { shopId: shop.id }, select: { id: true, name: true } });
    const showcaseName = new Map(showcases.map((s) => [s.id, s.name]));

    // Staff = manager grants to individual users (the owner is an `owner`/workspace tuple, not here).
    const shopStaff = await this.db.relationTuple.findMany({
      where: { resourceType: 'shop', resourceId: shop.id, relation: 'manager', subjectType: 'user' },
      select: { subjectId: true },
    });
    const showcaseStaff = showcases.length
      ? await this.db.relationTuple.findMany({
          where: { resourceType: 'showcase', resourceId: { in: showcases.map((s) => s.id) }, relation: 'manager', subjectType: 'user' },
          select: { resourceId: true, subjectId: true },
        })
      : [];

    const users = await this.userMinis([...shopStaff.map((t) => t.subjectId), ...showcaseStaff.map((t) => t.subjectId)]);
    const nameOf = (uid: string) => {
      const u = users.get(uid);
      return u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—';
    };
    const out: ShopStaffDto[] = [];
    for (const t of shopStaff) {
      out.push({ userId: t.subjectId, name: nameOf(t.subjectId), avatar: users.get(t.subjectId)?.avatar ?? null, scope: 'shop' });
    }
    for (const t of showcaseStaff) {
      out.push({
        userId: t.subjectId,
        name: nameOf(t.subjectId),
        avatar: users.get(t.subjectId)?.avatar ?? null,
        scope: 'showcase',
        showcaseId: t.resourceId,
        showcaseName: showcaseName.get(t.resourceId),
      });
    }
    return out;
  }

  async assignStaff(viewerId: string, data: AssignShopStaffRequest): Promise<void> {
    const { ownerType, ownerId } = this.resolveOwner(viewerId);
    const shop = await this.getOrCreateShop(ownerType, ownerId);
    if (!(await this.canManageShop(viewerId, shop))) throw new ForbiddenException('Нет прав на этот магазин');
    await this.assertInEnvironment(viewerId, data.userId);
    if (data.scope === 'shop') {
      await this.access.grant({ resourceType: 'shop', resourceId: shop.id, relation: 'manager', subjectType: 'user', subjectId: data.userId });
    } else {
      if (!data.showcaseId) throw new BadRequestException('Не указана витрина');
      const sc = await this.db.showcase.findUnique({ where: { id: data.showcaseId } });
      if (!sc || sc.shopId !== shop.id) throw new NotFoundException('Витрина не найдена');
      await this.access.grant({ resourceType: 'showcase', resourceId: data.showcaseId, relation: 'manager', subjectType: 'user', subjectId: data.userId });
    }
  }

  async revokeStaff(viewerId: string, userId: string, scope: string, showcaseId?: string): Promise<void> {
    const { ownerType, ownerId } = this.resolveOwner(viewerId);
    const shop = await this.getOrCreateShop(ownerType, ownerId);
    if (!(await this.canManageShop(viewerId, shop))) throw new ForbiddenException('Нет прав на этот магазин');
    if (scope === 'shop') {
      await this.access.revoke({ resourceType: 'shop', resourceId: shop.id, relation: 'manager', subjectType: 'user', subjectId: userId });
    } else if (showcaseId) {
      await this.access.revoke({ resourceType: 'showcase', resourceId: showcaseId, relation: 'manager', subjectType: 'user', subjectId: userId });
    }
  }

  // ============================================================
  // Authorization (delegated to the unified engine)
  // ============================================================

  private async canManageShop(viewerId: string, shop: ShopRow): Promise<boolean> {
    return this.access.can(this.user(viewerId), 'shop.manage', shop.id);
  }

  private async canViewShowcase(viewerId: string, showcaseId: string): Promise<boolean> {
    return this.access.can(this.user(viewerId), 'showcase.view', showcaseId);
  }

  /** Public: can the viewer see a showcase? Used by the rich-card 'listing.talk' gate. */
  async canViewShowcaseForCard(viewerId: string, showcaseId: string): Promise<boolean> {
    return this.canViewShowcase(viewerId, showcaseId);
  }

  private async loadShowcaseManageable(viewerId: string, showcaseId: string): Promise<ShowcaseRow> {
    const showcase = await this.db.showcase.findUnique({ where: { id: showcaseId } });
    if (!showcase) throw new NotFoundException('Витрина не найдена');
    if (!(await this.access.can(this.user(viewerId), 'showcase.manage', showcaseId))) {
      throw new ForbiddenException('Нет прав на эту витрину');
    }
    return showcase;
  }

  /** Showcases of a shop visible to the viewer (manager → all; else → ones they can view). */
  private async listShowcasesFor(viewerId: string, shop: ShopRow, canManage: boolean): Promise<ShowcaseDto[]> {
    const all = await this.db.showcase.findMany({ where: { shopId: shop.id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    let visible = all;
    if (!canManage) {
      const viewable = new Set(await this.access.listObjects(this.user(viewerId), 'viewer', 'showcase'));
      visible = all.filter((s) => viewable.has(s.id));
    }
    const counts = await this.db.listing.groupBy({
      by: ['showcaseId'],
      where: { showcaseId: { in: visible.map((s) => s.id) }, status: 'active' },
      _count: { _all: true },
    });
    const countById = new Map(counts.map((c) => [c.showcaseId, c._count._all]));
    const out: ShowcaseDto[] = [];
    for (const s of visible) {
      out.push(this.serializeShowcase(s, countById.get(s.id) ?? 0, canManage ? await this.loadShares(s.id) : undefined));
    }
    return out;
  }

  // ============================================================
  // Domain validation helpers
  // ============================================================

  /** Confirmed contact AND not blocked — shared gate in ContactsService. */
  private async assertInEnvironment(ownerId: string, otherId: string): Promise<void> {
    await this.contacts.assertReachable(ownerId, [otherId], 'Этот человек не в вашем окружении');
  }

  /** Validate a share target: a person must be in the environment; a circle must be the owner's. */
  private async assertSharePrincipal(shop: ShopRow, data: ShareShowcaseRequest): Promise<void> {
    if (data.principalType === 'user') {
      if (shop.ownerType === 'workspace') {
        const member = await this.db.workspaceMember.findFirst({
          where: { workspaceId: shop.ownerId, userId: data.principalId },
          select: { userId: true },
        });
        if (!member) throw new BadRequestException('Поделиться можно только с сотрудником компании');
      } else {
        await this.assertInEnvironment(shop.ownerId, data.principalId);
      }
    } else {
      const circle = await this.db.circle.findUnique({ where: { id: data.principalId }, select: { ownerId: true } });
      if (!circle || circle.ownerId !== shop.ownerId) throw new ForbiddenException('Группа не найдена');
    }
  }

  /** The owner's active currency (the only currency a Phase-2 listing can be priced in). */
  private async ownerCurrency(shop: ShopRow) {
    const currency = await this.db.currency.findFirst({
      where: { issuerType: shop.ownerType, issuerId: shop.ownerId, status: 'active' },
    });
    if (!currency) {
      throw new BadRequestException(
        shop.ownerType === 'user'
          ? 'Сначала создайте свою валюту в Кошельке, чтобы назначать цену'
          : 'Сначала создайте валюту компании в кошельке организации, чтобы назначать цену',
      );
    }
    return currency;
  }

  /**
   * Currencies the shop owner may price a listing in: their own + currencies issued by people in
   * their окружение (contacts). B2C only — a workspace owner's company currency is Phase 9 (→ []).
   */
  private async ownerPriceableCurrencies(
    ownerType: ShopOwnerType,
    ownerId: string,
  ): Promise<Array<{ id: string; name: string; icon: string; scale: number; issuerId: string }>> {
    // A company shop prices in the COMPANY currency only (B2B P9).
    if (ownerType === 'workspace') {
      const company = await this.db.currency.findFirst({
        where: { issuerType: 'workspace', issuerId: ownerId, status: 'active' },
        select: { id: true, name: true, icon: true, scale: true, issuerId: true },
      });
      return company ? [company] : [];
    }
    const links = await this.db.contactLink.findMany({
      where: { OR: [{ userAId: ownerId }, { userBId: ownerId }] },
      select: { userAId: true, userBId: true },
    });
    const issuerIds = [ownerId, ...links.map((l) => (l.userAId === ownerId ? l.userBId : l.userAId))];
    return this.db.currency.findMany({
      where: { issuerType: 'user', issuerId: { in: issuerIds }, status: 'active' },
      select: { id: true, name: true, icon: true, scale: true, issuerId: true },
    });
  }

  /**
   * Resolve the price a client sent into persistable lines. `prices` (cross-currency) wins; else
   * `priceAmount` is a single line in the owner's own currency; else undefined (price unchanged on
   * update). Validates every currency is the owner's own or an окружение contact's (Phase 5).
   */
  private async resolvePrices(
    shop: ShopRow,
    data: { prices?: Array<{ currencyId: string; amount: number }>; priceAmount?: number },
  ): Promise<PriceLine[] | undefined> {
    if (data.prices && data.prices.length > 0) {
      const allowed = new Set(
        (await this.ownerPriceableCurrencies(shop.ownerType as ShopOwnerType, shop.ownerId)).map((c) => c.id),
      );
      for (const line of data.prices) {
        if (!allowed.has(line.currencyId)) {
          throw new BadRequestException('Цена — только в своей валюте или валюте человека из окружения');
        }
      }
      return data.prices.map((l) => ({ currencyId: l.currencyId, amount: l.amount }));
    }
    if (data.priceAmount !== undefined) {
      const currency = await this.ownerCurrency(shop);
      return [{ currencyId: currency.id, amount: data.priceAmount }];
    }
    return undefined;
  }

  // ============================================================
  // Limits / availability / FOMO discount (Phase 7)
  // ============================================================

  /** A lot is sellable only while active and within its availability window. */
  private assertSellable(listing: { status: string; availableFrom: Date | null; availableUntil: Date | null }): void {
    if (listing.status !== 'active') throw new BadRequestException('Товар недоступен');
    const now = new Date();
    if (listing.availableFrom && now < listing.availableFrom) throw new BadRequestException('Продажи ещё не начались');
    if (listing.availableUntil && now > listing.availableUntil) throw new BadRequestException('Продажа закрыта');
  }

  /**
   * Price lines after applying an active FOMO discount (floor per currency, min 1). This is what gets
   * snapshotted onto the order / campaign goal, so the discounted price is LOCKED at purchase time.
   */
  private effectivePrices(
    listing: { prices: { currencyId: string; amount: bigint }[]; discountPercent: number | null; discountUntil: Date | null },
  ): { currencyId: string; amount: bigint }[] {
    const active = !!listing.discountPercent && listing.discountPercent > 0 && !!listing.discountUntil && new Date() < listing.discountUntil;
    const factor = active ? BigInt(100 - listing.discountPercent!) : 100n;
    return listing.prices.map((p) => {
      const v = active ? (p.amount * factor) / 100n : p.amount;
      return { currencyId: p.currencyId, amount: v < 1n ? 1n : v };
    });
  }

  /** Atomically reserve one unit of stock (oversell-safe; null limit = ∞). Throws when sold out. */
  private async reserveStock(tx: Prisma.TransactionClient, listingId: string): Promise<void> {
    const n = await tx.$executeRaw`UPDATE "listings" SET "stock_sold" = "stock_sold" + 1 WHERE "id" = ${listingId} AND ("stock_limit" IS NULL OR "stock_sold" < "stock_limit")`;
    if (n === 0) throw new BadRequestException('Товар распродан');
  }

  /** Release one reserved unit (cancel / reject / refund / expiry). Guarded so it never goes below 0. */
  private async restoreStock(tx: Prisma.TransactionClient, listingId: string | null): Promise<void> {
    if (!listingId) return;
    await tx.$executeRaw`UPDATE "listings" SET "stock_sold" = "stock_sold" - 1 WHERE "id" = ${listingId} AND "stock_sold" > 0`;
  }

  // ============================================================
  // Serialization
  // ============================================================

  private async serializeShop(shop: ShopRow, viewerId: string, canManage: boolean, showcaseCount: number): Promise<ShopDto> {
    let name = shop.name ?? '';
    if (!name) {
      if (shop.ownerType === 'user') {
        const u = (await this.userMinis([shop.ownerId])).get(shop.ownerId);
        name = u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : 'Магазин';
      } else {
        const ws = await this.db.workspace.findUnique({ where: { id: shop.ownerId }, select: { name: true } });
        name = ws?.name ?? 'Магазин';
      }
    }
    return {
      id: shop.id,
      ownerType: shop.ownerType as ShopOwnerType,
      ownerId: shop.ownerId,
      name,
      isOwner: shop.ownerType === 'user' ? shop.ownerId === viewerId : false,
      canManage,
      showcaseCount,
    };
  }

  private serializeShowcase(s: ShowcaseRow, listingCount: number, shares?: ShowcaseShareDto[]): ShowcaseDto {
    return {
      id: s.id,
      shopId: s.shopId,
      name: s.name,
      icon: s.icon,
      sortOrder: s.sortOrder,
      listingCount,
      ...(shares ? { shares } : {}),
    };
  }

  private serializeListing(
    r: Prisma.ListingGetPayload<{ include: typeof LISTING_INCLUDE }>,
    currencies: Map<string, { name: string; icon: string; scale: number }>,
    campaign: ListingDto['campaign'] = null,
    coverUrl: string | null = null,
  ): ListingDto {
    return {
      id: r.id,
      showcaseId: r.showcaseId,
      title: r.title,
      description: r.description,
      icon: r.icon,
      coverUrl,
      itemType: r.itemType as ListingDto['itemType'],
      withTask: r.withTask,
      taskDays: r.taskDays,
      crowdfunding: r.crowdfunding,
      stockLimit: r.stockLimit,
      stockSold: r.stockSold,
      availableFrom: r.availableFrom?.toISOString() ?? null,
      availableUntil: r.availableUntil?.toISOString() ?? null,
      discountPercent: r.discountPercent,
      discountUntil: r.discountUntil?.toISOString() ?? null,
      status: r.status as ListingDto['status'],
      prices: r.prices.map((p) => {
        const c = currencies.get(p.currencyId);
        return {
          currencyId: p.currencyId,
          currencyName: c?.name ?? '—',
          currencyIcon: c?.icon ?? '🪙',
          scale: c?.scale ?? 0,
          amount: Number(p.amount),
        };
      }),
      campaign,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Showcase audiences for the owner's UI — read from the engine's viewer tuples. */
  private async loadShares(showcaseId: string): Promise<ShowcaseShareDto[]> {
    const tuples = await this.db.relationTuple.findMany({
      where: { resourceType: 'showcase', resourceId: showcaseId, relation: 'viewer', subjectType: { in: ['user', 'circle'] } },
      select: { subjectType: true, subjectId: true },
    });
    const userIds = tuples.filter((t) => t.subjectType === 'user').map((t) => t.subjectId);
    const circleIds = tuples.filter((t) => t.subjectType === 'circle').map((t) => t.subjectId);
    const users = await this.userMinis(userIds);
    const circles = new Map(
      (await this.db.circle.findMany({ where: { id: { in: circleIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    return tuples.map((t) => {
      if (t.subjectType === 'user') {
        const u = users.get(t.subjectId);
        return { principalType: 'user' as const, principalId: t.subjectId, name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—' };
      }
      return { principalType: 'circle' as const, principalId: t.subjectId, name: circles.get(t.subjectId) ?? 'Группа' };
    });
  }

  private serializeOrder(
    r: OrderWithDetail,
    currencies: Map<string, { name: string; icon: string; scale: number }>,
    opts: {
      buyerName?: string;
      viewerId?: string;
      contributorNames?: Map<string, { firstName: string; lastName: string | null; avatar: string | null }>;
      listingCoverUrl?: string | null;
    } = {},
  ): OrderDto {
    const dto: OrderDto = {
      id: r.id,
      listingId: r.listingId,
      listingCoverUrl: opts.listingCoverUrl ?? null,
      title: r.titleSnapshot,
      showcaseId: r.showcaseId,
      shopId: r.shopId,
      buyerId: r.buyerId,
      buyerName: opts.buyerName,
      sellerId: r.sellerId,
      status: r.status as OrderDto['status'],
      prices: r.prices.map((p) => {
        const c = currencies.get(p.currencyId);
        return {
          currencyId: p.currencyId,
          currencyName: c?.name ?? '—',
          currencyIcon: c?.icon ?? '🪙',
          scale: c?.scale ?? 0,
          amount: Number(p.amount),
        };
      }),
      itemType: r.itemType as OrderDto['itemType'],
      withTask: r.withTask,
      crowdfunding: r.crowdfunding,
      createdAt: r.createdAt.toISOString(),
    };
    if (r.crowdfunding) {
      const raised = new Map<string, bigint>();
      for (const c of r.contributions) raised.set(c.currencyId, (raised.get(c.currencyId) ?? 0n) + c.amount);
      dto.raised = [...raised.entries()].map(([currencyId, amount]) => ({ currencyId, amount: Number(amount) }));
      if (opts.viewerId) {
        dto.myContribution = r.contributions
          .filter((c) => c.contributorId === opts.viewerId)
          .map((c) => ({ currencyId: c.currencyId, amount: Number(c.amount) }));
      }
      if (opts.contributorNames) {
        const totals = new Map<string, number>();
        for (const c of r.contributions) totals.set(c.contributorId, (totals.get(c.contributorId) ?? 0) + Number(c.amount));
        dto.contributors = [...totals.entries()]
          .map(([userId, total]) => {
            const u = opts.contributorNames!.get(userId);
            return { userId, name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—', total };
          })
          .sort((a, b) => b.total - a.total);
      }
    }
    return dto;
  }

  private async currencyMap(ids: string[]): Promise<Map<string, { name: string; icon: string; scale: number }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.currency.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, icon: true, scale: true } });
    return new Map(rows.map((c) => [c.id, { name: c.name, icon: c.icon, scale: c.scale }]));
  }

  private async userMinis(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map<string, { firstName: string; lastName: string | null; avatar: string | null }>();
    const users = await this.db.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }
}
