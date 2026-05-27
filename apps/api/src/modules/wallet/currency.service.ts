import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WALLET_LIMITS } from '@superapp/shared';
import type {
  Currency as CurrencyDto,
  WalletEntry,
  LedgerEntryDto,
  CurrencyHolder,
  LedgerEntryType,
  IssuerType,
  CreateCurrencyRequest,
  UpdateCurrencyRequest,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { LedgerService } from './ledger.service';

type CurrencyRow = Prisma.CurrencyGetPayload<object>;

/**
 * Currency lifecycle + the user-facing wallet (B2C). Owns policy (one active currency per
 * issuer, the 1×/3-months rename, cascade-burn on delete, minting against an owned currency)
 * and delegates the actual money movements to LedgerService.
 */
@Injectable()
export class CurrencyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ============================================================
  // Currency lifecycle
  // ============================================================

  async getMyCurrency(userId: string): Promise<CurrencyDto | null> {
    const row = await this.activeCurrencyOf('user', userId);
    return row ? this.toDto(row, userId) : null;
  }

  async createCurrency(userId: string, data: CreateCurrencyRequest): Promise<CurrencyDto> {
    const existing = await this.activeCurrencyOf('user', userId);
    if (existing) {
      throw new ConflictException('У вас уже есть валюта. Можно изменить её или удалить.');
    }
    try {
      const row = await this.db.currency.create({
        data: {
          issuerType: 'user',
          issuerId: userId,
          name: data.name.trim(),
          icon: data.icon,
        },
      });
      return this.toDto(row, userId);
    } catch (err) {
      // Partial unique index guards a race (two concurrent creates).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('У вас уже есть валюта.');
      }
      throw err;
    }
  }

  /** Rename / re-icon — at most once per 3 months. Retroactive (everything references the id). */
  async renameCurrency(userId: string, data: UpdateCurrencyRequest): Promise<CurrencyDto> {
    const row = await this.activeCurrencyOf('user', userId);
    if (!row) throw new NotFoundException('У вас ещё нет валюты');

    if (row.lastRenamedAt) {
      const nextAt = this.renameNextAt(row.lastRenamedAt);
      if (nextAt && nextAt.getTime() > Date.now()) {
        throw new BadRequestException(
          `Менять валюту можно раз в 3 месяца. Следующее изменение — после ${nextAt.toLocaleDateString('ru-RU')}`,
        );
      }
    }

    const updated = await this.db.currency.update({
      where: { id: row.id },
      data: {
        name: data.name?.trim() ?? row.name,
        icon: data.icon ?? row.icon,
        lastRenamedAt: new Date(),
      },
    });
    return this.toDto(updated, userId);
  }

  /**
   * Delete the currency. Soft-delete + cascade burn: every holder's balance is zeroed with a
   * `currency_deleted` ledger line (the journal stays consistent), and any active escrow holds
   * are released. In-flight tasks are NOT cancelled — they simply lose this reward (handled
   * task-side once escrow is wired in Phase 3).
   */
  async deleteCurrency(userId: string): Promise<void> {
    const row = await this.activeCurrencyOf('user', userId);
    if (!row) throw new NotFoundException('У вас ещё нет валюты');

    await this.db.$transaction(async (tx) => {
      const balances = await tx.walletBalance.findMany({ where: { currencyId: row.id } });
      for (const wb of balances) {
        if (wb.balance !== 0n) {
          await tx.ledgerEntry.create({
            data: {
              currencyId: row.id,
              accountUserId: wb.accountUserId,
              amount: -wb.balance,
              entryType: 'currency_deleted',
              memo: 'Валюта удалена эмитентом',
            },
          });
        }
        await tx.walletBalance.update({
          where: { id: wb.id },
          data: { balance: 0n, heldAmount: 0n },
        });
      }
      await tx.escrowHold.updateMany({
        where: { currencyId: row.id, status: 'active' },
        data: { status: 'released' },
      });
      await tx.currency.update({
        where: { id: row.id },
        data: { status: 'deleted', deletedAt: new Date() },
      });
    });
  }

  /** Manually emit coins of one's own currency onto one's own balance (capped at 10M in hand). */
  async mint(userId: string, amount: number): Promise<WalletEntry> {
    const row = await this.activeCurrencyOf('user', userId);
    if (!row) throw new BadRequestException('Сначала создайте свою валюту');
    await this.ledger.mint({ currencyId: row.id, ownerUserId: userId, amount });
    const bal = await this.ledger.getBalance(userId, row.id);
    return {
      currencyId: row.id,
      name: row.name,
      icon: row.icon,
      issuerId: userId,
      issuerName: '',
      balance: bal.balance,
      held: bal.held,
      available: bal.available,
      isOwn: true,
    };
  }

  /** Holder burns a FOREIGN currency from their balance (irreversible). Own currency is deleted instead. */
  async burn(userId: string, currencyId: string, amount: number): Promise<WalletEntry> {
    const currency = await this.db.currency.findUnique({ where: { id: currencyId } });
    if (!currency || currency.status !== 'active') throw new NotFoundException('Валюта не найдена');
    if (currency.issuerType === 'user' && currency.issuerId === userId) {
      throw new BadRequestException('Свою валюту нельзя сжечь — её можно удалить целиком');
    }
    await this.ledger.burn({ currencyId, holderUserId: userId, amount });
    const bal = await this.ledger.getBalance(userId, currencyId);
    return {
      currencyId,
      name: currency.name,
      icon: currency.icon,
      issuerId: currency.issuerId,
      issuerName: '',
      balance: bal.balance,
      held: bal.held,
      available: bal.available,
      isOwn: false,
    };
  }

  // ============================================================
  // Wallet views
  // ============================================================

  /** All currencies the viewer holds (own currency always shown), with balances. */
  async getWallet(userId: string): Promise<WalletEntry[]> {
    const balances = await this.db.walletBalance.findMany({ where: { accountUserId: userId } });
    const ids = new Set(balances.map((b) => b.currencyId));
    const own = await this.activeCurrencyOf('user', userId);
    if (own) ids.add(own.id);
    if (ids.size === 0) return [];

    const currencies = await this.db.currency.findMany({
      where: { id: { in: [...ids] }, status: 'active' },
    });
    const issuerUserIds = [
      ...new Set(currencies.filter((c) => c.issuerType === 'user').map((c) => c.issuerId)),
    ];
    const nameById = await this.userNames(issuerUserIds);
    const balById = new Map(balances.map((b) => [b.currencyId, b]));

    const out: WalletEntry[] = [];
    for (const c of currencies) {
      const b = balById.get(c.id);
      const balance = b?.balance ?? 0n;
      const held = b?.heldAmount ?? 0n;
      const isOwn = c.issuerType === 'user' && c.issuerId === userId;
      if (!isOwn && balance === 0n && held === 0n) continue; // hide empty foreign currencies
      out.push({
        currencyId: c.id,
        name: c.name,
        icon: c.icon,
        issuerId: c.issuerId,
        issuerName: c.issuerType === 'user' ? nameById.get(c.issuerId) ?? '—' : '—',
        balance: Number(balance),
        held: Number(held),
        available: Number(balance - held),
        isOwn,
      });
    }
    out.sort((a, b) => (a.isOwn === b.isOwn ? b.balance - a.balance : a.isOwn ? -1 : 1));
    return out;
  }

  /** Cursor-paginated transaction history for the viewer (their ledger lines). */
  async getHistory(
    userId: string,
    q: { currencyId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: LedgerEntryDto[]; nextCursor: string | null }> {
    const limit = Math.min(q.limit ?? WALLET_LIMITS.historyPageSize, 100);
    const where: Prisma.LedgerEntryWhereInput = { accountUserId: userId };
    if (q.currencyId) where.currencyId = q.currencyId;
    if (q.cursor) where.id = { lt: BigInt(q.cursor) };

    const rows = await this.db.ledgerEntry.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((r) => ({
        id: r.id.toString(),
        currencyId: r.currencyId,
        entryType: r.entryType as LedgerEntryType,
        amount: Number(r.amount),
        taskId: r.taskId,
        transferId: r.transferId,
        memo: r.memo,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].id.toString() : null,
    };
  }

  /** "Holders of my currency" (cap table). Issuer-only by construction — uses the caller's own currency. */
  async getHolders(userId: string): Promise<CurrencyHolder[]> {
    const c = await this.activeCurrencyOf('user', userId);
    if (!c) return [];
    const rows = await this.db.walletBalance.findMany({
      where: { currencyId: c.id, accountUserId: { not: userId }, balance: { not: 0n } },
    });
    const names = await this.userMinis(rows.map((r) => r.accountUserId));
    return rows
      .map((r) => {
        const u = names.get(r.accountUserId);
        return {
          userId: r.accountUserId,
          name: u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : '—',
          avatar: u?.avatar ?? null,
          balance: Number(r.balance),
        };
      })
      .sort((a, b) => b.balance - a.balance);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private activeCurrencyOf(issuerType: IssuerType, issuerId: string): Promise<CurrencyRow | null> {
    return this.db.currency.findFirst({ where: { issuerType, issuerId, status: 'active' } });
  }

  private renameNextAt(lastRenamedAt: Date): Date {
    return new Date(lastRenamedAt.getTime() + WALLET_LIMITS.renameCooldownDays * 86_400_000);
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName ?? ''}`.trim()]));
  }

  private async userMinis(ids: string[]) {
    if (ids.length === 0) return new Map<string, { firstName: string; lastName: string | null; avatar: string | null }>();
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  private toDto(row: CurrencyRow, viewerId: string): CurrencyDto {
    const nextAt = row.lastRenamedAt ? this.renameNextAt(row.lastRenamedAt) : null;
    return {
      id: row.id,
      issuerType: row.issuerType as IssuerType,
      issuerId: row.issuerId,
      name: row.name,
      icon: row.icon,
      currencyType: 'CUSTOM_COIN',
      status: row.status as CurrencyDto['status'],
      isOwner: row.issuerType === 'user' && row.issuerId === viewerId,
      renameAvailableAt: nextAt && nextAt.getTime() > Date.now() ? nextAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
