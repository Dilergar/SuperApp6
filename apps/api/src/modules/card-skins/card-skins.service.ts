import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PLATFORM_CURRENCY,
  type CardSkinRender,
  type CardSkinTokens,
  type CardSkinCatalogItem,
  type CardSkinInstanceDto,
  type CardSkinWallet,
  type CardSkinEquipState,
  type SkinRarity,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LedgerService } from '../wallet/ledger.service';

type Tx = Prisma.TransactionClient;

/**
 * Card Skins — platform-sold cosmetic skins for the PersonCard.
 *
 *  - A skin is DATA (tokens + layer assets). `CardSkin` is the design/type;
 *    `CardSkinInstance` is an owned copy ("real item") with a serial for limited skins
 *    and a transfer history that future gift/trade will append to.
 *  - Purchases use the single platform currency (issuerType='platform') over the
 *    double-entry Ledger: buyer → platform revenue account, then mint the instance.
 *    Instant (no escrow); escrow/trade comes later on the same instance model.
 *  - Equip: one default skin for everyone + per-group overrides (premium). When a viewer
 *    is in several of the owner's groups, the group highest in the list (smallest sortOrder)
 *    wins; if the owner's premium lapsed, per-group overrides are ignored → default.
 */
@Injectable()
export class CardSkinsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ============================================================
  // Platform currency + wallet
  // ============================================================

  /** Get (or lazily create) the single platform premium currency. */
  private async getPlatformCurrency(client: Tx | DatabaseService = this.db) {
    const existing = await client.currency.findFirst({
      where: { issuerType: PLATFORM_CURRENCY.issuerType, issuerId: PLATFORM_CURRENCY.issuerId, status: 'active' },
    });
    if (existing) return existing;
    try {
      return await client.currency.create({
        data: {
          issuerType: PLATFORM_CURRENCY.issuerType,
          issuerId: PLATFORM_CURRENCY.issuerId,
          name: PLATFORM_CURRENCY.name,
          icon: PLATFORM_CURRENCY.icon,
          scale: PLATFORM_CURRENCY.scale,
          currencyType: 'CUSTOM_COIN',
          status: 'active',
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return (await client.currency.findFirst({
          where: { issuerType: PLATFORM_CURRENCY.issuerType, issuerId: PLATFORM_CURRENCY.issuerId, status: 'active' },
        }))!;
      }
      throw err;
    }
  }

  async getWallet(userId: string): Promise<CardSkinWallet> {
    const currency = await this.getPlatformCurrency();
    const { balance } = await this.ledger.getBalance(userId, currency.id);
    return { currencyId: currency.id, name: currency.name, icon: currency.icon, balance };
  }

  /** TEST-ONLY top-up: mint platform currency to the user. Real payment rails come later. */
  async topUp(userId: string, amount: number): Promise<CardSkinWallet> {
    const currency = await this.getPlatformCurrency();
    await this.ledger.mint({ currencyId: currency.id, ownerType: 'user', ownerId: userId, amount });
    return this.getWallet(userId);
  }

  // ============================================================
  // Catalog
  // ============================================================

  async listCatalog(userId: string): Promise<CardSkinCatalogItem[]> {
    const skins = await this.db.cardSkin.findMany({
      where: { status: 'active' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const owned = await this.db.cardSkinInstance.findMany({
      where: { ownerId: userId, skinId: { in: skins.map((s) => s.id) } },
      select: { skinId: true },
    });
    const ownedSet = new Set(owned.map((o) => o.skinId));
    const now = Date.now();
    return skins.map((s) => this.toCatalogItem(s, ownedSet, now));
  }

  // ============================================================
  // Purchase
  // ============================================================

  async buy(userId: string, skinId: string): Promise<CardSkinInstanceDto> {
    return this.db.$transaction(async (tx) => {
      const currency = await this.getPlatformCurrency(tx);
      // Atomically reserve a copy: increments minted only if active, in-window and not sold out.
      // Oversell-safe (same pattern as the Shop stock reservation).
      const reserved = await tx.$queryRaw<Array<{ minted: number; supply: number | null; price_amount: bigint }>>(
        Prisma.sql`
          UPDATE card_skins
          SET minted = minted + 1, updated_at = now()
          WHERE id = ${skinId}
            AND status = 'active'
            AND (supply IS NULL OR minted < supply)
            AND (available_from IS NULL OR available_from <= now())
            AND (available_until IS NULL OR available_until >= now())
          RETURNING minted, supply, price_amount
        `,
      );

      if (reserved.length === 0) {
        await this.explainUnavailable(tx, skinId); // throws a precise 400/404
      }
      const { minted, supply, price_amount } = reserved[0];
      const price = Number(price_amount);

      // Charge the platform currency: buyer → platform revenue account. Rolls back the
      // reservation above if the buyer can't pay (whole thing is one transaction).
      if (price > 0) {
        const buyerAcct = await this.ledger.getOrCreateUserAccount(tx, currency.id, userId);
        const platformAcct = await this.ledger.getOrCreateHolderAccount(tx, currency.id, 'system', PLATFORM_CURRENCY.issuerId);
        await this.ledger.transfer(tx, {
          currencyId: currency.id,
          fromAccountId: buyerAcct.id,
          toAccountId: platformAcct.id,
          amount: price,
          memo: `card-skin:${skinId}`,
        });
      }

      // Mint the owned instance (serial only for limited skins) + record provenance.
      const serial = supply !== null ? minted : null;
      const instance = await tx.cardSkinInstance.create({
        data: { skinId, ownerId: userId, serial, acquiredVia: 'purchase' },
        include: { skin: true },
      });
      await tx.cardSkinTransfer.create({
        data: { instanceId: instance.id, fromUserId: null, toUserId: userId, kind: 'mint' },
      });

      return this.toInstanceDto(instance);
    });
  }

  private async explainUnavailable(tx: Tx, skinId: string): Promise<never> {
    const s = await tx.cardSkin.findUnique({ where: { id: skinId } });
    if (!s || s.status !== 'active') throw new NotFoundException('Скин недоступен');
    const now = new Date();
    if (s.availableFrom && s.availableFrom > now) throw new BadRequestException('Продажи скина ещё не начались');
    if (s.availableUntil && s.availableUntil < now) throw new BadRequestException('Продажи скина завершены');
    if (s.supply !== null && s.minted >= s.supply) {
      throw new BadRequestException('Скин распродан — теперь только через обмен');
    }
    throw new BadRequestException('Скин недоступен');
  }

  // ============================================================
  // Inventory
  // ============================================================

  async listInventory(userId: string): Promise<CardSkinInstanceDto[]> {
    const instances = await this.db.cardSkinInstance.findMany({
      where: { ownerId: userId },
      include: { skin: true },
      orderBy: { createdAt: 'desc' },
    });
    return instances.map((i) => this.toInstanceDto(i));
  }

  // ============================================================
  // Equip
  // ============================================================

  async getEquipState(userId: string): Promise<CardSkinEquipState> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { defaultSkinInstanceId: true, premiumUntil: true },
    });
    const circles = await this.db.circle.findMany({
      where: { ownerId: userId, equippedSkinInstanceId: { not: null } },
      select: { id: true, equippedSkinInstanceId: true },
    });

    // Self-heal: equip pointers are plain ids (no FK). If an equipped instance is
    // no longer owned (future trade / delete), null the dangling pointer so the
    // card cleanly falls back to the default instead of silently losing its skin.
    const referenced = [
      user?.defaultSkinInstanceId,
      ...circles.map((c) => c.equippedSkinInstanceId),
    ].filter((x): x is string => !!x);
    const ownedIds = referenced.length
      ? new Set(
          (
            await this.db.cardSkinInstance.findMany({
              where: { id: { in: referenced }, ownerId: userId },
              select: { id: true },
            })
          ).map((i) => i.id),
        )
      : new Set<string>();

    let defaultInstanceId = user?.defaultSkinInstanceId ?? null;
    if (defaultInstanceId && !ownedIds.has(defaultInstanceId)) {
      await this.db.user.update({ where: { id: userId }, data: { defaultSkinInstanceId: null } });
      defaultInstanceId = null;
    }

    const perGroup: CardSkinEquipState['perGroup'] = [];
    for (const c of circles) {
      const eid = c.equippedSkinInstanceId;
      if (!eid) continue;
      if (ownedIds.has(eid)) {
        perGroup.push({ circleId: c.id, instanceId: eid });
      } else {
        await this.db.circle.update({ where: { id: c.id }, data: { equippedSkinInstanceId: null } });
      }
    }

    return {
      defaultInstanceId,
      perGroup,
      premium: this.isPremium(user?.premiumUntil ?? null),
    };
  }

  async equipDefault(userId: string, instanceId: string | null): Promise<CardSkinEquipState> {
    if (instanceId) await this.assertOwnsInstance(userId, instanceId);
    await this.db.user.update({ where: { id: userId }, data: { defaultSkinInstanceId: instanceId } });
    return this.getEquipState(userId);
  }

  async equipForGroup(userId: string, circleId: string, instanceId: string | null): Promise<CardSkinEquipState> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { premiumUntil: true } });
    if (!this.isPremium(user?.premiumUntil ?? null)) {
      throw new ForbiddenException('Разные скины на группы доступны на премиум-тарифе');
    }
    const circle = await this.db.circle.findUnique({ where: { id: circleId }, select: { ownerId: true } });
    if (!circle || circle.ownerId !== userId) throw new NotFoundException('Группа не найдена');
    if (instanceId) await this.assertOwnsInstance(userId, instanceId);
    await this.db.circle.update({ where: { id: circleId }, data: { equippedSkinInstanceId: instanceId } });
    return this.getEquipState(userId);
  }

  private async assertOwnsInstance(userId: string, instanceId: string): Promise<void> {
    const inst = await this.db.cardSkinInstance.findUnique({ where: { id: instanceId }, select: { ownerId: true } });
    if (!inst || inst.ownerId !== userId) throw new ForbiddenException('Это не ваш скин');
  }

  private isPremium(premiumUntil: Date | null): boolean {
    return !!premiumUntil && premiumUntil.getTime() > Date.now();
  }

  // ============================================================
  // Resolve — which skin a viewer sees on each owner's card
  // ============================================================

  async resolveSkinsForViewer(
    viewerId: string,
    ownerIds: string[],
  ): Promise<Record<string, CardSkinRender | null>> {
    const result: Record<string, CardSkinRender | null> = {};
    const ids = [...new Set(ownerIds)].filter(Boolean);
    if (ids.length === 0) return result;

    const owners = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, defaultSkinInstanceId: true, premiumUntil: true },
    });
    const premiumOwnerIds = owners.filter((o) => this.isPremium(o.premiumUntil)).map((o) => o.id);

    // Map each premium owner → the contact link between them and the viewer.
    const linkByOwner = new Map<string, string>();
    if (premiumOwnerIds.length) {
      const links = await this.db.contactLink.findMany({
        where: {
          OR: [
            { userAId: viewerId, userBId: { in: premiumOwnerIds } },
            { userBId: viewerId, userAId: { in: premiumOwnerIds } },
          ],
        },
        select: { id: true, userAId: true, userBId: true },
      });
      for (const l of links) {
        linkByOwner.set(l.userAId === viewerId ? l.userBId : l.userAId, l.id);
      }
    }

    // For each premium owner, the equipped skin of the highest-priority group the viewer is in.
    const groupEquipByOwner = new Map<string, string>();
    if (linkByOwner.size) {
      const linkIds = [...linkByOwner.values()];
      const circles = await this.db.circle.findMany({
        where: {
          ownerId: { in: premiumOwnerIds },
          equippedSkinInstanceId: { not: null },
          memberships: { some: { contactLinkId: { in: linkIds } } },
        },
        select: {
          ownerId: true,
          equippedSkinInstanceId: true,
          memberships: { where: { contactLinkId: { in: linkIds } }, select: { contactLinkId: true } },
        },
        orderBy: { sortOrder: 'asc' },
      });
      for (const c of circles) {
        if (groupEquipByOwner.has(c.ownerId)) continue; // smallest sortOrder already taken
        const ownersLink = linkByOwner.get(c.ownerId);
        if (ownersLink && c.memberships.some((m) => m.contactLinkId === ownersLink)) {
          groupEquipByOwner.set(c.ownerId, c.equippedSkinInstanceId!);
        }
      }
    }

    // Chosen instance per owner: group override (premium) → default.
    const chosenByOwner = new Map<string, string>();
    for (const o of owners) {
      const inst = groupEquipByOwner.get(o.id) ?? o.defaultSkinInstanceId ?? null;
      if (inst) chosenByOwner.set(o.id, inst);
    }

    const instanceIds = [...new Set(chosenByOwner.values())];
    const instances = instanceIds.length
      ? await this.db.cardSkinInstance.findMany({ where: { id: { in: instanceIds } }, include: { skin: true } })
      : [];
    const instMap = new Map(instances.map((i) => [i.id, i]));

    for (const ownerId of ids) {
      const instId = chosenByOwner.get(ownerId);
      const inst = instId ? instMap.get(instId) : null;
      // Guard: the equipped instance must still belong to the owner.
      result[ownerId] = inst && inst.ownerId === ownerId ? this.skinToRender(inst.skin) : null;
    }
    return result;
  }

  // ============================================================
  // Serializers
  // ============================================================

  private skinToRender(skin: {
    id: string; name: string; rarity: string; tokens: Prisma.JsonValue;
    frameUrl: string | null; backgroundUrl: string | null; effectUrl: string | null; decor: string;
  }): CardSkinRender {
    return {
      id: skin.id,
      name: skin.name,
      rarity: skin.rarity as SkinRarity,
      tokens: skin.tokens as unknown as CardSkinTokens,
      frameUrl: skin.frameUrl,
      backgroundUrl: skin.backgroundUrl,
      effectUrl: skin.effectUrl,
      decor: (skin.decor as 'crayon' | 'none') ?? 'none',
    };
  }

  private toInstanceDto(instance: {
    id: string; skinId: string; serial: number | null; acquiredVia: string; createdAt: Date;
    skin: { id: string; name: string; rarity: string; tokens: Prisma.JsonValue; description: string | null;
      frameUrl: string | null; backgroundUrl: string | null; effectUrl: string | null; decor: string };
  }): CardSkinInstanceDto {
    return {
      id: instance.id,
      skinId: instance.skinId,
      serial: instance.serial,
      acquiredVia: instance.acquiredVia,
      createdAt: instance.createdAt.toISOString(),
      skin: { ...this.skinToRender(instance.skin), description: instance.skin.description },
    };
  }

  private toCatalogItem(
    s: {
      id: string; name: string; description: string | null; rarity: string; priceAmount: bigint;
      supply: number | null; minted: number; availableFrom: Date | null; availableUntil: Date | null;
      tokens: Prisma.JsonValue; decor: string; frameUrl: string | null; backgroundUrl: string | null;
      effectUrl: string | null; status: string;
    },
    ownedSet: Set<string>,
    now: number,
  ): CardSkinCatalogItem {
    const soldOut = s.supply !== null && s.minted >= s.supply;
    const inWindow =
      (!s.availableFrom || s.availableFrom.getTime() <= now) &&
      (!s.availableUntil || s.availableUntil.getTime() >= now);
    return {
      ...this.skinToRender(s),
      description: s.description,
      priceAmount: Number(s.priceAmount),
      supply: s.supply,
      minted: s.minted,
      remaining: s.supply === null ? null : Math.max(0, s.supply - s.minted),
      soldOut,
      availableFrom: s.availableFrom?.toISOString() ?? null,
      availableUntil: s.availableUntil?.toISOString() ?? null,
      available: s.status === 'active' && inWindow && !soldOut,
      owned: ownedSet.has(s.id),
    };
  }
}
