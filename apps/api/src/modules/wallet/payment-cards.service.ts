import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { UserPaymentCard } from '@prisma/client';
import {
  REQUISITE_LIMITS,
  maskCardPan,
  type CreatePaymentCardInput,
  type UpdatePaymentCardInput,
  type UserPaymentCardDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { decryptField, encryptField } from '../../shared/crypto/secret-field';

/** Контекст шифрования: свой на класс полей — расшифровка кредов Процессов карты не открывает */
const CARD_CTX = 'payment-card';

/**
 * Карты человека в «Кошельке» — РЕКВИЗИТ для выплат (зарплата, возвраты), а не
 * платёжный инструмент: без CVV, платежи платформа через карту не проводит.
 *
 * Номер и IBAN карт-счёта шифруются в БД (AES-256-GCM, паттерн сейфа кредов
 * Процессов); полностью они отдаются ДВУМ зрителям, ради которых блок существует:
 * самому владельцу и управляющим его организаций (второй, нередактируемый уровень
 * «Видимости в Компаниях» — данные для трудоустройства и выплат). Коллегам карта
 * видна только если владелец включил тумблер paymentCard в extras.
 *
 * Карт несколько, одна — основная (Kaspi Gold + зарплатная Halyk — обычный набор);
 * именно основная показывается в реквизитах и будет подставляться в документы.
 */
@Injectable()
export class PaymentCardsService {
  private readonly logger = new Logger(PaymentCardsService.name);

  constructor(private readonly db: DatabaseService) {}

  async list(userId: string): Promise<UserPaymentCardDto[]> {
    const rows = await this.db.userPaymentCard.findMany({
      where: { userId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.serialize(r));
  }

  async create(userId: string, dto: CreatePaymentCardInput): Promise<UserPaymentCardDto> {
    const row = await this.db.$transaction(async (tx) => {
      const count = await tx.userPaymentCard.count({ where: { userId } });
      if (count >= REQUISITE_LIMITS.maxCardsPerUser) {
        throw new BadRequestException(`Не больше ${REQUISITE_LIMITS.maxCardsPerUser} карт — удалите ненужную`);
      }
      // Первая карта становится основной сама; явный isPrimary снимает флаг с прочих.
      const makePrimary = dto.isPrimary || count === 0;
      if (makePrimary) {
        await tx.userPaymentCard.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } });
      }
      return tx.userPaymentCard.create({
        data: {
          userId,
          panEncrypted: encryptField(CARD_CTX, dto.pan),
          panLast4: dto.pan.slice(-4),
          ibanEncrypted: dto.iban ? encryptField(CARD_CTX, dto.iban) : null,
          holderName: dto.holderName,
          expMonth: dto.expMonth,
          expYear: dto.expYear,
          isPrimary: makePrimary,
        },
      });
    });
    return this.serialize(row);
  }

  /** Номер карты не правится (реквизит новой карты = новая запись) — прочее можно */
  async update(userId: string, cardId: string, dto: UpdatePaymentCardInput): Promise<UserPaymentCardDto> {
    const row = await this.db.$transaction(async (tx) => {
      const card = await tx.userPaymentCard.findFirst({ where: { id: cardId, userId } });
      if (!card) throw new NotFoundException('Карта не найдена');
      if (dto.isPrimary) {
        await tx.userPaymentCard.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } });
      }
      return tx.userPaymentCard.update({
        where: { id: card.id },
        data: {
          ...(dto.iban !== undefined
            ? { ibanEncrypted: dto.iban === null ? null : encryptField(CARD_CTX, dto.iban) }
            : {}),
          ...(dto.holderName !== undefined ? { holderName: dto.holderName } : {}),
          ...(dto.expMonth !== undefined ? { expMonth: dto.expMonth } : {}),
          ...(dto.expYear !== undefined ? { expYear: dto.expYear } : {}),
          ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
        },
      });
    });
    return this.serialize(row);
  }

  async remove(userId: string, cardId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const card = await tx.userPaymentCard.findFirst({ where: { id: cardId, userId } });
      if (!card) throw new NotFoundException('Карта не найдена');
      await tx.userPaymentCard.delete({ where: { id: card.id } });
      // Основную удалили — роль переходит старейшей из оставшихся: «основная» не должна
      // пропадать, пока есть хоть одна карта (на неё смотрят реквизиты у работодателя).
      if (card.isPrimary) {
        const next = await tx.userPaymentCard.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.userPaymentCard.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
  }

  /**
   * Основные карты СПИСКА людей — сервисный API для ростера «Сотрудники»
   * (реквизитный блок manager+). Ключ — userId; расшифровка здесь, чтобы знание
   * о шифровании не расползалось за пределы этого сервиса.
   */
  async primaryCardsFor(
    userIds: string[],
  ): Promise<Map<string, { pan: string; iban: string | null; holderName: string; expMonth: number; expYear: number }>> {
    const out = new Map<string, { pan: string; iban: string | null; holderName: string; expMonth: number; expYear: number }>();
    if (!userIds.length) return out;
    const rows = await this.db.userPaymentCard.findMany({
      where: { userId: { in: userIds }, isPrimary: true },
    });
    for (const r of rows) {
      try {
        out.set(r.userId, {
          pan: decryptField(CARD_CTX, r.panEncrypted),
          iban: r.ibanEncrypted ? decryptField(CARD_CTX, r.ibanEncrypted) : null,
          holderName: r.holderName,
          expMonth: r.expMonth,
          expYear: r.expYear,
        });
      } catch (err) {
        // Смена JWT_SECRET делает старые поля нечитаемыми (задокументированная цена
        // производного ключа) — строка просто выпадает из выдачи, не роняя ростер.
        this.logger.warn(`карта ${r.id}: не расшифровалась (${err instanceof Error ? err.message : err})`);
      }
    }
    return out;
  }

  private serialize(row: UserPaymentCard): UserPaymentCardDto {
    return {
      id: row.id,
      // Владельцу — полностью: с маской он не смог бы ни проверить опечатку, ни продиктовать.
      pan: decryptField(CARD_CTX, row.panEncrypted),
      panMasked: maskCardPan(row.panLast4),
      iban: row.ibanEncrypted ? decryptField(CARD_CTX, row.ibanEncrypted) : null,
      holderName: row.holderName,
      expMonth: row.expMonth,
      expYear: row.expYear,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
