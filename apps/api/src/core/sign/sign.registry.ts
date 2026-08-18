import { Injectable, Logger } from '@nestjs/common';

/**
 * Предмет подписи глазами потребителя. Возвращает резолвер: движок сам не знает
 * ни документов, ни счетов, ни договоров.
 */
export interface SignSubjectContext {
  /** Файл, чьи БАЙТЫ подписываются */
  fileId: string;
  /**
   * Вариант файла (`pdf` у офисного документа). Движок прочитает именно его и
   * положит НЕИЗМЕНЯЕМУЮ копию: вариант умирает при первой же правке исходника
   * (`replaceContent` сносит производные), и подписанные байты можно было бы
   * физически потерять.
   */
  variant?: string;
  title: string;
  icon?: string;
  workspaceId: string | null;
  /** Владелец замороженной копии: за организацией, а не за тем, кто нажал кнопку */
  ownerType: 'user' | 'workspace';
  ownerId: string;
}

/** Минимум о предмете для ПУБЛИЧНОЙ страницы проверки (ст. 61 ЦК) */
export interface SignVerifyDescription {
  /** Название документа — без содержимого */
  title: string;
  /** Вид документа: «Приказ», «Договор» */
  kindLabel?: string | null;
  /** От чьего имени документ — организация */
  orgLabel?: string | null;
}

/** Что движок сообщает потребителю о закрытом акте */
export interface SignActFinishedInfo {
  requestId: string;
  actId: string;
  outcome: 'signed' | 'declined';
  level: 'ecp' | 'pep';
  signerUserId: string | null;
  /** Все ли подписанты закрыли заявку */
  requestCompleted: boolean;
}

/**
 * Резолвер потребителя движка подписи. Регистрируется в onModuleInit своего
 * модуля (паттерн FilesRefRegistry / ShareLinksRegistry / ApprovalsRegistry):
 * движок не импортирует ни один функциональный модуль, направление знания —
 * только от потребителя к движку.
 *
 * Новый сервис получает электронную подпись одной регистрацией: заморозка
 * предмета, акт, протокол, публичная проверка и экспортный пакет уже есть.
 */
export interface SignRefProvider {
  /**
   * ЧТО именно подписываем. null — предмета нет либо он не в том состоянии, когда
   * его можно подписывать (черновик, отменён): движок ответит `sign_subject_gone`.
   */
  resolveSubject(refId: string): Promise<SignSubjectContext | null>;

  /**
   * Право ОТПРАВИТЬ этот предмет на подпись. Тот же контракт, что у
   * `describeForCreate` в согласованиях, и по той же причине: движок предметной
   * области не знает и подтвердить право не может, а через этот метод проходит
   * ЛЮБОЕ заведение заявки.
   */
  canRequestSign(userId: string, refId: string): Promise<boolean>;

  /**
   * Право ВИДЕТЬ подписи предмета (блок «Подписи» на карточке). Отсутствует →
   * видят только участники подписания и автор заявки.
   */
  canView?(userId: string, refId: string): Promise<boolean>;

  /**
   * Подпись предмета для ПУБЛИЧНОЙ страницы проверки. Отдаёт МИНИМУМ: название,
   * вид и организацию — и ничего из содержимого. Отсутствует → страница покажет
   * снимок названия со строки заявки.
   */
  describeForVerify?(refId: string): Promise<SignVerifyDescription | null>;

  /**
   * Акт закрылся. Здесь потребитель ставит свои отметки («документ подписан»,
   * хроника, уведомления). Best-effort и ПОСЛЕ коммита: упавший хук не имеет
   * права откатить уже совершённую подпись.
   */
  onActFinished?(refId: string, info: SignActFinishedInfo): Promise<void>;

  /**
   * Срок сбора подписей ИСТЁК (крон закрыл заявку). Зовётся джобом, поставленным
   * В ТОЙ ЖЕ транзакции закрытия: без хука предмет потребителя навсегда оставался
   * бы «у контрагента» — сам движок про статусы предмета не знает. Уведомление об
   * истечении шлёт ПОТРЕБИТЕЛЬ (у него контекст: «документ вернулся в черновик»),
   * движкового типа не существует намеренно.
   */
  onRequestExpired?(refId: string, info: { requestId: string }): Promise<void>;

  /**
   * Сверка сертификата ВНЕШНЕГО подписанта с предметом (внешний контур ЭДО):
   * договор должен подписать тот, с кем его заключают, а не «кто-то с действующим
   * ключом». Зовётся ДО финализации акта гостя. `{ok:false}` → жёсткий отказ
   * `sign_counterparty_mismatch` (акт не хоронится — человек мог выбрать не тот
   * ключ в NCALayer). Отсутствует → сверки нет (личность держит SMS-номер).
   */
  checkGuestCert?(
    refId: string,
    cert: { iin: string | null; bin: string | null },
  ): Promise<{ ok: boolean; reason?: string }>;
}

@Injectable()
export class SignRegistry {
  private readonly logger = new Logger(SignRegistry.name);
  private readonly entries = new Map<string, SignRefProvider>();

  register(refType: string, provider: SignRefProvider): void {
    if (this.entries.has(refType)) {
      this.logger.warn(`provider for "${refType}" already registered — overwriting`);
    }
    this.entries.set(refType, provider);
  }

  get(refType: string): SignRefProvider | undefined {
    return this.entries.get(refType);
  }

  /** Зарегистрированные типы — для дев-диагностики и сообщений об ошибке */
  types(): string[] {
    return [...this.entries.keys()];
  }
}
