import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiError, badRequest } from '../../shared/errors/api-error';
import { SMS_OUTBOUND_LIMITS, isKzMobilePhone, maskPhone } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { RedisService } from '../../shared/redis/redis.service';
import { VerifySmsService, type SmsSendResult } from './verify.sms';

/**
 * Исходящие СЛУЖЕБНЫЕ SMS (не OTP): доставка ссылок наружу — «организация
 * отправила вам документ на подпись».
 *
 * ЗАРОДЫШ будущего канального движка уведомлений: живёт рядом с SMS-драйвером
 * (канал один и тот же), контракт узкий — `sendLink(workspaceId, phone, text)`,
 * и когда каналов станет больше (WhatsApp, e-mail), он переезжает в отдельный
 * движок дёшево, не меняя вызывающих.
 *
 * Эшелоны против расхода денег (SMS — деньги, а ручку жмёт человек):
 *  1) гео-щит — только казахстанские мобильные (правило движка verify);
 *  2) кулдаун 60с на пару «объект + номер» (двойной клик ≠ две SMS);
 *  3) суточный потолок организации — скользящее окно в Redis (две корзины,
 *     модель бюджета verify: фиксированное окно обнулялось бы на границе суток).
 */
@Injectable()
export class SmsOutboundService {
  private readonly logger = new Logger(SmsOutboundService.name);

  constructor(
    private readonly sms: VerifySmsService,
    private readonly redis: RedisService,
  ) {}

  /** Реальная доставка настроена (mock → false: веб прячет кнопку SMS) */
  get live(): boolean {
    return this.sms.driver.live;
  }

  /**
   * Отправить служебную SMS со ссылкой. `refKey` — ключ объекта («org_document:id»)
   * для кулдауна. Ошибка канала НЕ откатывает действие вызывающего: ссылка
   * копируема, и «отправьте её сами» — честный запасной путь.
   */
  async sendLink(
    workspaceId: string,
    phone: string,
    text: string,
    opts: { refKey: string },
  ): Promise<void> {
    // В dev mock-драйвер пишет SMS в лог — путь проверяется сьютом без денег.
    if (!this.live && !isDevEnv()) {
      throw badRequest('verify.smsNotConfigured');
    }
    if (!isKzMobilePhone(phone)) {
      throw badRequest('verify.kzMobileOnly');
    }

    // Бюджет тратится по ФАКТУ отправки (правило бюджета verify): сначала
    // читаем без инкремента — исчерпанный предел и упавший шлюз денег не жгут.
    // Предел проверяется ДО кулдауна: иначе отказ «предел исчерпан» оставлял бы
    // занятый кулдаун, и повтор через минуту врал бы «SMS уже отправлена».
    const budgetPrefix = `smsout:ws:${workspaceId}`;
    const used = await this.slidingPeek(budgetPrefix, 24 * 3600);
    if (used >= SMS_OUTBOUND_LIMITS.perWorkspaceDaily) {
      throw badRequest('verify.orgDailyLimit');
    }

    const client = this.redis.getClient();
    const cdKey = `smsout:cd:${opts.refKey}:${phone}`;
    const won = await client.set(cdKey, '1', 'EX', SMS_OUTBOUND_LIMITS.perTargetCooldownSec, 'NX');
    if (won !== 'OK') {
      throw badRequest('verify.alreadySent');
    }

    // Кулдаун снимаем на ЛЮБОМ неуспехе, а не только на честном `{ok:false}`:
    // упавший драйвер (таймаут, оборванное соединение) бросает, и без catch ключ
    // оставался занятым — повтор через секунду отвечал «SMS уже отправлена этому
    // номеру», хотя контрагент не получил ничего.
    let res: SmsSendResult;
    try {
      res = await this.sms.driver.send(phone, text);
    } catch (e) {
      await client.del(cdKey).catch(() => undefined);
      this.logger.warn(`SMS → ${maskPhone(phone)} was not sent: ${(e as Error).message}`);
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, { code: 'verify.gatewayDown' });
    }
    if (!res.ok) {
      await client.del(cdKey).catch(() => undefined);
      this.logger.warn(`SMS → ${maskPhone(phone)} was not sent: ${res.error ?? 'no reason given'}`);
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, { code: 'verify.gatewayDown' });
    }
    await this.slidingRecord(budgetPrefix, 24 * 3600).catch(() => undefined);
  }

  /**
   * Тревожная SMS ВЛАДЕЛЬЦУ АККАУНТА на его собственный номер (запрошено удаление аккаунта).
   * Не зависит от opt-in на SMS-уведомления: это защита от угона сессии, а не рассылка.
   * Гео-щита нет (номер не выбирает клиент), потолок — одна SMS на человека за `accountAlertCooldownSec`.
   * Best-effort: `false` — не отправлено (кулдаун, шлюз, mock в production); действие вызывающего не откатывается.
   */
  async sendAccountAlert(userId: string, phone: string, text: string): Promise<boolean> {
    if (!this.live && !isDevEnv()) return false;
    const client = this.redis.getClient();
    const cdKey = `smsout:account:${userId}`;
    const won = await client.set(cdKey, '1', 'EX', SMS_OUTBOUND_LIMITS.accountAlertCooldownSec, 'NX').catch(() => null);
    if (won !== 'OK') return false;
    try {
      const res = await this.sms.driver.send(phone, text);
      if (!res.ok) throw new Error(res.error ?? 'no reason given');
      return true;
    } catch (e) {
      await client.del(cdKey).catch(() => undefined);
      this.logger.warn(`Account alert SMS → ${maskPhone(phone)} was not sent: ${(e as Error).message}`);
      return false;
    }
  }

  /** Ключи двух корзин скользящего окна + доля прошедшего окна */
  private windowOf(prefix: string, windowSec: number) {
    const nowSec = Date.now() / 1000;
    const bucket = Math.floor(nowSec / windowSec);
    return {
      curKey: `${prefix}:${bucket}`,
      prevKey: `${prefix}:${bucket - 1}`,
      elapsed: (nowSec % windowSec) / windowSec,
    };
  }

  /** Прочитать скользящее окно БЕЗ инкремента (проверка предела) */
  private async slidingPeek(prefix: string, windowSec: number): Promise<number> {
    const client = this.redis.getClient();
    const { curKey, prevKey, elapsed } = this.windowOf(prefix, windowSec);
    const [current, previous] = await Promise.all([client.get(curKey), client.get(prevKey)]);
    return (Number(current) || 0) + (Number(previous) || 0) * (1 - elapsed);
  }

  /** Записать состоявшуюся отправку в окно (две корзины, копия модели verify) */
  private async slidingRecord(prefix: string, windowSec: number): Promise<void> {
    const client = this.redis.getClient();
    const { curKey } = this.windowOf(prefix, windowSec);
    await client.multi().incr(curKey).expire(curKey, windowSec * 2).exec();
  }
}
