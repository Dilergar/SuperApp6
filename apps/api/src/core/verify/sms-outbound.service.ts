import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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
      throw new BadRequestException('SMS-канал не настроен — скопируйте ссылку и отправьте её сами');
    }
    if (!isKzMobilePhone(phone)) {
      throw new BadRequestException('SMS отправляются только на казахстанские мобильные номера');
    }

    // Бюджет тратится по ФАКТУ отправки (правило бюджета verify): сначала
    // читаем без инкремента — исчерпанный предел и упавший шлюз денег не жгут.
    // Предел проверяется ДО кулдауна: иначе отказ «предел исчерпан» оставлял бы
    // занятый кулдаун, и повтор через минуту врал бы «SMS уже отправлена».
    const budgetPrefix = `smsout:ws:${workspaceId}`;
    const used = await this.slidingPeek(budgetPrefix, 24 * 3600);
    if (used >= SMS_OUTBOUND_LIMITS.perWorkspaceDaily) {
      throw new BadRequestException('Суточный предел служебных SMS организации исчерпан');
    }

    const client = this.redis.getClient();
    const cdKey = `smsout:cd:${opts.refKey}:${phone}`;
    const won = await client.set(cdKey, '1', 'EX', SMS_OUTBOUND_LIMITS.perTargetCooldownSec, 'NX');
    if (won !== 'OK') {
      throw new BadRequestException('SMS уже отправлена этому номеру — повторить можно через минуту');
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
      this.logger.warn(`SMS → ${maskPhone(phone)} не ушла: ${(e as Error).message}`);
      throw new ServiceUnavailableException('SMS-шлюз недоступен — скопируйте ссылку и отправьте её сами');
    }
    if (!res.ok) {
      await client.del(cdKey).catch(() => undefined);
      this.logger.warn(`SMS → ${maskPhone(phone)} не ушла: ${res.error ?? 'без причины'}`);
      throw new ServiceUnavailableException('SMS-шлюз недоступен — скопируйте ссылку и отправьте её сами');
    }
    await this.slidingRecord(budgetPrefix, 24 * 3600).catch(() => undefined);
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
