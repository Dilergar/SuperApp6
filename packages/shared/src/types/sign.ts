// ============================================================
// core/sign — типы провода
// ============================================================
// Здесь только конверт ДВИЖКА. Предмет подписи (документ, счёт, договор)
// описывает потребитель у себя: движок по определению не знает своих
// потребителей, и его паспорт не должен наполняться чужими анкетами.
//
// Каждый тип обязан стоять на ОБЕИХ сторонах провода (правило «Контракт API ↔
// клиенты»): тип, импортированный только на API, врёт.

import type {
  SignActEventType,
  SignActStatus,
  SignLevel,
  SignMethod,
  SignOcspStatus,
  SignRequestStatus,
  SignSignerType,
} from '../constants/sign';

/** Человек в подписи — только карточкой (Принцип 2), поэтому лайт-профиль */
export interface SignActorLite {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

/** Событие протокола подписания (append-only) */
export interface SignActEventDto {
  /** BigInt в БД — на проводе ВСЕГДА строка */
  id: string;
  type: SignActEventType;
  at: string;
  /** IP виден только тем, кто вправе смотреть доказательства (владелец/подписант) */
  ip: string | null;
  userAgent: string | null;
  /** Подробности события (номер попытки, серийник, длина контейнера…) */
  data: Record<string, unknown> | null;
}

/**
 * Сведения о сертификате — снимок НА МОМЕНТ ПОДПИСАНИЯ.
 *
 * Их нельзя пересчитывать позже: юридически значим статус сертификата тогда,
 * когда человек подписывал. Через год сертификат истечёт, OCSP-ответчик о нём
 * забудет, и «живая» проверка не докажет ничего.
 */
export interface SignCertificateDto {
  subjectCn: string | null;
  /**
   * ИИН физлица из сертификата — ВСЕГДА маскированный (`85••••••1234`). Полный ИИН
   * наружу не отдаётся ни на публичной странице проверки, ни на карточке документа:
   * блок «Подписи» видит каждый, кому виден документ. Несокращённое значение живёт
   * только в БД (`SignAct.certSubjectIin`) — для сверки личности и будущего аудита.
   */
  iin: string | null;
  /** БИН организации — есть у ключей юрлица (подпись «от компании») */
  bin: string | null;
  serial: string | null;
  issuerCn: string | null;
  notBefore: string | null;
  notAfter: string | null;
  /** Цепочка построена до корня НУЦ РК */
  chainValid: boolean;
  /** Статус в OCSP в момент подписания */
  ocspStatus: SignOcspStatus | null;
  ocspAt: string | null;
  /** Метка доверенного времени (TSP) — она и есть юридическое время подписи */
  tspAt: string | null;
  tspSerial: string | null;
}

/** Одна подпись одного лица */
export interface SignActDto {
  id: string;
  requestId: string;
  signerType: SignSignerType;
  signerUserId: string | null;
  signerGuestId: string | null;
  /** Снимок имени: акт обязан читаться и после удаления аккаунта */
  signerName: string;
  /** Маскированный номер у ПЭП и у гостя; полный не показываем никому лишнему */
  signerPhoneMasked: string | null;
  method: SignMethod | null;
  level: SignLevel;
  status: SignActStatus;
  /** Отпечаток того, что подписано (копия с заявки — акт самодостаточен) */
  subjectSha256: string;
  certificate: SignCertificateDto | null;
  /** Снимок соглашения сторон о ПЭП — доказательство ст. 47 ЦК */
  consentText: string | null;
  consentVersion: string | null;
  signedAt: string | null;
  declineReason: string | null;
  createdAt: string;
  /** Адрес публичной проверки этого акта (с токеном) — печатается в QR протокола */
  checkUrl: string | null;
}

/** Заявка: что подписываем и кто должен подписать */
export interface SignRequestDto {
  id: string;
  refType: string;
  refId: string;
  /** Снимок названия предмета — переживает удаление объекта */
  refTitle: string;
  refIcon: string | null;
  workspaceId: string | null;
  level: SignLevel;
  /** Способы, разрешённые этой заявкой (пересечение уровня и включённых драйверов) */
  methods: SignMethod[];
  status: SignRequestStatus;
  /**
   * ЗАМОРОЖЕННАЯ копия предмета: движок сам читает байты и кладёт их отдельным
   * неизменяемым файлом. «Что видел = что подписал» — по построению, а не по
   * договорённости потребителя.
   */
  subjectFileId: string;
  subjectSha256: string;
  /** Шаг маршрута, который закроется этой подписью; null — подпись сама по себе */
  approvalStepId: string | null;
  createdById: string;
  createdAt: string;
  expiresAt: string | null;
  completedAt: string | null;
  acts: SignActDto[];
  actors: Record<string, SignActorLite>;
}

/** Ссылка на замороженный документ — то, что подписант видит перед подписью */
export interface SignSubjectViewDto {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** Подписанная ссылка на байты (протухает — клиент перезапрашивает страницу) */
  url: string;
  expiresAt: string;
}

/**
 * Всё, что нужно экрану подписания, одним ответом: заявка, замороженный предмет,
 * мой акт и то, что от меня требуется прямо сейчас.
 */
export interface SignFlowDto {
  request: SignRequestDto;
  subject: SignSubjectViewDto;
  /** Мой акт (создаётся вместе с заявкой); null — я не подписант */
  myAct: SignActDto | null;
  /** Что показать в окне подписания */
  canSign: boolean;
  /** Текст соглашения сторон о ПЭП — показывается ДО ввода кода */
  consentText: string | null;
  consentVersion: string | null;
  /** Внешнему подписанту нужно ещё и согласие на обработку ПД (ст. 8 ЗоПД) */
  pdConsentText: string | null;
}

/** Ответ старта ПЭП: код ушёл, ждём ввода */
export interface SignPepStartDto {
  challengeId: string;
  resendInSec: number;
  ttlSec: number;
  phoneMasked: string;
}

/** Ответ старта QR: картинку рисует СЕРВЕР (data-URL), либу в бандл не тащим */
export interface SignQrStartDto {
  sessionId: string;
  /** PNG data-URL с QR — то, что показывается на экране */
  qrDataUrl: string;
  /** Тот же адрес строкой: на телефоне ссылку можно открыть напрямую */
  deepLink: string;
  expiresAt: string;
  /** Как часто спрашивать «подписали?» */
  pollMs: number;
  /** Драйвер работает в mock (Smart Bridge ещё не подключён) */
  mock: boolean;
}

/** Состояние подписания для поллинга: короткий ответ, без всей заявки */
export interface SignActStateDto {
  actId: string;
  status: SignActStatus;
  requestStatus: SignRequestStatus;
  signedAt: string | null;
  declineReason: string | null;
  /** Код ошибки, если подпись отвергнута — клиент показывает человеческий текст */
  errorCode: string | null;
}

/**
 * Результат ПУБЛИЧНОЙ проверки подписи (ст. 61 ЦК — открытый сервис проверки).
 *
 * Файл при проверке НЕ покидает браузер: sha256 считается Web Crypto, на сервер
 * уходит только хэш. Байты документа мы проверяющему не отдаём — их приносит он
 * сам; отдаём CMS и квитанции, чтобы подпись можно было проверить и сторонними
 * средствами (eGov, ezSigner).
 */
export interface SignCheckResultDto {
  found: boolean;
  /**
   * Чем совпал принесённый файл: `subject` — это сам подписанный оригинал,
   * `stamped_copy` — ШТАМПОВАННАЯ копия (PDF с полосами и «Листом подписей»):
   * у неё свой отпечаток, а подписи стоят под оригиналом (`subject.sha256`).
   * Страница проверки обязана это объяснить — иначе несовпадение хэшей выглядит
   * как подделка.
   */
  matchedBy?: 'subject' | 'stamped_copy';
  /** Что подписано — минимум от потребителя, без содержимого */
  subject: {
    title: string;
    kindLabel: string | null;
    orgLabel: string | null;
    sha256: string;
  } | null;
  signatures: SignCheckSignatureDto[];
  /** Отдаём для сторонней проверки; байтов документа здесь нет намеренно */
  downloads: SignCheckDownloadDto[];
}

export interface SignCheckSignatureDto {
  actId: string;
  signerName: string;
  /** ИИН МАСКИРОВАН: страница открыта всякому, кто получил файл */
  iinMasked: string | null;
  orgName: string | null;
  method: SignMethod | null;
  level: SignLevel;
  /** Юридическое время подписи: метка TSP у ЭЦП, время системы у ПЭП */
  signedAt: string | null;
  issuerCn: string | null;
  certSerial: string | null;
  certNotAfter: string | null;
  /** Вердикты — ЗАМОРОЖЕННЫЕ на момент подписания, а не пересчитанные сейчас */
  chainValid: boolean | null;
  ocspStatus: SignOcspStatus | null;
  ocspAt: string | null;
}

export interface SignCheckDownloadDto {
  /** cms | ocsp | tsp | protocol */
  kind: string;
  label: string;
  url: string;
}

/** Строка блока «Подписи» на карточке потребителя */
export interface SignSummaryDto {
  requestId: string;
  level: SignLevel;
  status: SignRequestStatus;
  subjectSha256: string;
  createdAt: string;
  completedAt: string | null;
  acts: SignActDto[];
  actors: Record<string, SignActorLite>;
  /** Может ли зритель прямо сейчас подписать (сервер уже проверил) */
  myActId: string | null;
  /** Готовы ли артефакты: протокол и экспортный пакет */
  canExport: boolean;
  /**
   * Штампованная копия: итоговый PDF с полосами-штампами на каждой странице и
   * «Листом подписей» (Doodocs-модель). Собирается джобом после завершения
   * заявки; НЕ доказательство (перегенерируема) — доказательства это CMS и
   * замороженная копия.
   */
  stamped?: { ready: boolean; url: string | null };
}

/**
 * Гостевая страница подписания (`session.view` при refType='sign_request').
 * Живёт в shared по правилу контракта: тип стоит и у резолвера (API), и у
 * `ShareSignView` (веб) — локальная рукопись на вебе разъезжалась бы молча.
 */
export interface ShareSignGuestView {
  kind: 'sign';
  requestId: string;
  title: string;
  status: SignRequestStatus;
  level: SignLevel;
  methods: SignMethod[];
  subject: { fileId: string; name: string; mime: string; size: number; sha256: string; url: string };
  signed: { name: string; at: string | null }[];
  consentText: string;
  consentVersion: string;
  pdConsentText: string;
  /**
   * СОСТОЯНИЕ ВЕРНУВШЕГОСЯ подписанта: его акт, если он уже действовал по этой
   * ссылке. Страница открывается сразу на «Вы подписали…»/«Вы отказались:
   * причина», а не на «Перейти к подписанию». null — гость ещё не действовал
   * либо личность не подтверждена.
   */
  myAct: { status: SignActStatus; signedAt: string | null; declineReason: string | null } | null;
  /** Штампованная копия готова — done-экран показывает кнопки скачивания */
  stamped: { ready: boolean };
}

/** Режим движка — веб прячет способы, которых нет в этом окружении */
export interface SignStatusDto {
  /** Хоть один способ доступен */
  enabled: boolean;
  methods: SignMethod[];
  /** Верификатор ЭЦП работает по-настоящему (не mock) */
  verifierLive: boolean;
  /** Мост eGov Mobile подключён по-настоящему */
  qrLive: boolean;
  /** ЭЦП принимается вообще (в production с mock-верификатором — нет) */
  ecpAccepted: boolean;
}
