import { Injectable, Logger } from '@nestjs/common';

/**
 * Драйвер сдачи в ЕСУТД (erdo.enbek.kz) — СЛОТ по образцу драйверов SMS и
 * верификатора подписи: контракт зафиксирован, боевая реализация подключится,
 * когда АО «ЦРТР» даст доступ к API и песочницу (заявка — внешний блокер;
 * интеграции уже есть у 1С:ЭТД, Doodocs, idocs — путь проторен).
 *
 * Продукт этим НЕ блокируется: работает ручной путь — счётчик сроков,
 * «Скопировать сведения» (по перечню Правил № 353) и «Отметить сданным».
 */
export interface EsutdDriver {
  readonly live: boolean;
  /** Отправить сведения; вернуть номер регистрации в ЕСУТД */
  submit(payload: Record<string, unknown>): Promise<{ externalNumber: string }>;
}

@Injectable()
export class MockEsutdDriver implements EsutdDriver {
  private readonly logger = new Logger(MockEsutdDriver.name);
  readonly live = false;

  async submit(): Promise<{ externalNumber: string }> {
    // Честный отказ, а не имитация успеха: «сдано в ЕСУТД» без реальной сдачи —
    // это ровно та недостоверность, за которую штрафует ст. 98 КоАП.
    throw new Error('API ЕСУТД не подключено — отметьте сдачу вручную после подачи через кабинет enbek.kz');
  }
}
