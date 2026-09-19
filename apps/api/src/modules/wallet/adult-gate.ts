import { CONSENT_AGE, CONSENT_ERROR_CODES, ageOnDate, platformTodayIso } from '@superapp/shared';
import type { DatabaseService } from '../../shared/database/database.service';
import { forbidden } from '../../shared/errors/api-error';

/**
 * Платежи реальными деньгами — с 18 лет (ГК РК ст. 22: до совершеннолетия сделки — с согласия
 * законных представителей; подтверждение родителем придёт с семейным профилем). Регистрация
 * открыта с 16, поэтому возраст проверяется ЗДЕСЬ — на двери денег, а не на входе в продукт.
 * Коины, задачи и всё бесплатное ограничений не имеют. Нет даты рождения — отказ (fail-closed).
 * Дата читается обычным клиентом базы: ПДн расшифровывает Prisma-расширение движка ключей.
 */
export async function assertAdultForPayment(db: Pick<DatabaseService, 'user'>, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true, kind: true } });
  const dob = user?.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null;
  const age = dob ? ageOnDate(dob, platformTodayIso()) : Number.NaN;
  if (!user || user.kind !== 'person' || !Number.isFinite(age) || age < CONSENT_AGE.adult) {
    throw forbidden(CONSENT_ERROR_CODES.paymentsMinorNotAllowed, { age: CONSENT_AGE.adult });
  }
}
