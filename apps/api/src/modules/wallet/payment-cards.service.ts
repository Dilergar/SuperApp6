import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { UserPaymentCard } from '@prisma/client';
import {
  REQUISITE_LIMITS,
  maskCardPan,
  type CreatePaymentCardInput,
  type UpdatePaymentCardInput,
  type UserPaymentCardDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { KeysEnvelopeService } from '../../core/keys/keys.envelope.service';
import { KeysFieldRegistry } from '../../core/keys/keys.registry';
import { isLegacyAesField, legacyAesDecrypt, legacySha256Key } from '../../core/keys/keys.legacy';

/** Сущность AAD: шифротекст привязан к карте человека и полю — перенос в чужую строку не читается */
const CARD_ENTITY = 'user_payment_card';
/** Прошлая эпоха: ключ sha256('field:payment-card:' + мастер-секрет) — только чтение на legacy-окне */
const LEGACY_KEY_PREFIX = 'field:payment-card:';
type CardField = 'pan' | 'iban';

/** Открытый текст поля карты прошлого формата (для джоба перешивки); null — не legacy / окно закрыто. */
function legacyCardPlain(stored: string): string | null {
  if (!isLegacyAesField(stored)) return null;
  const key = legacySha256Key(LEGACY_KEY_PREFIX);
  if (!key) return null;
  try {
    return legacyAesDecrypt(key, stored);
  } catch {
    return null;
  }
}

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
export class PaymentCardsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentCardsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly keys: KeysEnvelopeService,
    private readonly keyFields: KeysFieldRegistry,
  ) {}

  /** Колонки карт — в реестре движка ключей: перешивка при ротации KEK, legacy-джоб. */
  onModuleInit(): void {
    for (const [column, field] of [
      ['pan_encrypted', 'pan'],
      ['iban_encrypted', 'iban'],
    ] as const) {
      this.keyFields.register({
        table: 'user_payment_cards',
        idColumn: 'id',
        column,
        scope: 'user',
        scopeColumn: 'user_id',
        entity: CARD_ENTITY,
        field,
        legacyDecrypt: (stored) => legacyCardPlain(stored),
      });
    }
  }

  private ctx(userId: string, field: CardField) {
    return { entity: CARD_ENTITY, field, ownerType: 'user', ownerId: userId };
  }

  private encrypt(userId: string, field: CardField, plain: string): Promise<string> {
    return this.keys.encrypt({ type: 'user', id: userId }, this.ctx(userId, field), plain);
  }

  /** Расшифровка поля: envelope; прошлый формат — только на legacy-окне (до перешивки джобом). */
  private async decrypt(userId: string, field: CardField, stored: string): Promise<string> {
    if (this.keys.isEnvelope(stored)) return this.keys.decrypt({ type: 'user', id: userId }, this.ctx(userId, field), stored);
    const legacy = legacyCardPlain(stored);
    if (legacy === null) throw new Error('the card field is unreadable (legacy window closed or damaged)');
    return legacy;
  }

  async list(userId: string): Promise<UserPaymentCardDto[]> {
    const rows = await this.db.userPaymentCard.findMany({
      where: { userId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return Promise.all(rows.map((r) => this.serialize(r)));
  }

  async create(userId: string, dto: CreatePaymentCardInput): Promise<UserPaymentCardDto> {
    // Шифрование — ДО транзакции (unwrap KEK может стоить похода в БД)
    const panEncrypted = await this.encrypt(userId, 'pan', dto.pan);
    const ibanEncrypted = dto.iban ? await this.encrypt(userId, 'iban', dto.iban) : null;
    const row = await this.db.$transaction(async (tx) => {
      const count = await tx.userPaymentCard.count({ where: { userId } });
      if (count >= REQUISITE_LIMITS.maxCardsPerUser) {
        throw badRequest('wallet.tooManyCards', { max: REQUISITE_LIMITS.maxCardsPerUser });
      }
      // Первая карта становится основной сама; явный isPrimary снимает флаг с прочих.
      const makePrimary = dto.isPrimary || count === 0;
      if (makePrimary) {
        await tx.userPaymentCard.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } });
      }
      return tx.userPaymentCard.create({
        data: {
          userId,
          panEncrypted,
          panLast4: dto.pan.slice(-4),
          ibanEncrypted,
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
    const ibanEncrypted = dto.iban ? await this.encrypt(userId, 'iban', dto.iban) : null;
    const row = await this.db.$transaction(async (tx) => {
      const card = await tx.userPaymentCard.findFirst({ where: { id: cardId, userId } });
      if (!card) throw notFound('wallet.cardNotFound');
      if (dto.isPrimary) {
        await tx.userPaymentCard.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } });
      }
      return tx.userPaymentCard.update({
        where: { id: card.id },
        data: {
          ...(dto.iban !== undefined
            ? { ibanEncrypted: dto.iban === null ? null : ibanEncrypted }
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
      if (!card) throw notFound('wallet.cardNotFound');
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
          pan: await this.decrypt(r.userId, 'pan', r.panEncrypted),
          iban: r.ibanEncrypted ? await this.decrypt(r.userId, 'iban', r.ibanEncrypted) : null,
          holderName: r.holderName,
          expMonth: r.expMonth,
          expYear: r.expYear,
        });
      } catch (err) {
        // Замороженный/уничтоженный KEK человека или битая строка — карта просто
        // выпадает из выдачи, не роняя ростер.
        this.logger.warn(`card ${r.id}: failed to decrypt (${err instanceof Error ? err.message : err})`);
      }
    }
    return out;
  }

  private async serialize(row: UserPaymentCard): Promise<UserPaymentCardDto> {
    return {
      id: row.id,
      // Владельцу — полностью: с маской он не смог бы ни проверить опечатку, ни продиктовать.
      pan: await this.decrypt(row.userId, 'pan', row.panEncrypted),
      panMasked: maskCardPan(row.panLast4),
      iban: row.ibanEncrypted ? await this.decrypt(row.userId, 'iban', row.ibanEncrypted) : null,
      holderName: row.holderName,
      expMonth: row.expMonth,
      expYear: row.expYear,
      isPrimary: row.isPrimary,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
