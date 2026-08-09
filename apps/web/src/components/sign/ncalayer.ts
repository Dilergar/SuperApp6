// ============================================================
// NCALayer — подписание ключом НУЦ РК на СТОРОНЕ ПОЛЬЗОВАТЕЛЯ.
//
// Ключ никогда не покидает компьютер человека: браузер соединяется с локальной
// программой NCALayer по WebSocket `wss://127.0.0.1:13579`, она показывает окно
// выбора сертификата, собирает CMS и отдаёт готовый контейнер. Сервер получает
// только его — и проверяет верификатором, ничего не зная про ключи.
//
// Просить пароль ключа или сам ключ на нашей странице НЕЛЬЗЯ ни при каких
// условиях: это ровно та схема, которой пользуются поддельные «порталы ЭЦП».
// ============================================================

const NCALAYER_URL = 'wss://127.0.0.1:13579';
/** Модуль «basics» — актуальный интерфейс NCALayer (прежний kz.gov.pki.knca.commonUtils устарел) */
const MODULE = 'kz.gov.pki.knca.basics';

export interface NcaLayerSignOptions {
  /** Что подписываем — base64 замороженного документа */
  dataBase64: string;
  /**
   * Какие ключи показывать. Для подписи документа это ключ ПОДПИСИ (SIGN),
   * а не аутентификации: AUTH-ключом ЭЦП под документом не ставят.
   */
  keyTypes?: ('SIGN' | 'AUTH')[];
  /** Ждать ответа не дольше: человек выбирает сертификат и вводит пароль руками */
  timeoutMs?: number;
}

export class NcaLayerError extends Error {
  constructor(
    message: string,
    /** true — человек сам закрыл окно выбора: это не сбой, ругаться не нужно */
    readonly cancelled = false,
  ) {
    super(message);
  }
}

/**
 * Запросить у NCALayer отсоединённую подпись (detached CMS) с меткой времени.
 *
 * `tsaProfile` просим у самого NCALayer: метку доверенного времени вшивает НУЦ,
 * и без неё юридическое время подписи взялось бы из часов нашего сервера.
 */
export function signWithNcaLayer(opts: NcaLayerSignOptions): Promise<string> {
  const { dataBase64, keyTypes = ['SIGN'], timeoutMs = 5 * 60_000 } = opts;

  return new Promise<string>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(NCALAYER_URL);
    } catch {
      reject(new NcaLayerError('Не удалось соединиться с NCALayer'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new NcaLayerError('NCALayer не ответил — окно подписи закрыто или программа зависла'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* сокет уже закрыт — это норма */
      }
    };

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          module: MODULE,
          method: 'signData',
          args: {
            allowedStorages: null, // все хранилища: файл, токен, удостоверение
            format: 'cms',
            data: dataBase64,
            signingParams: { decode: 'true', encapsulate: 'false', digested: 'false', tsaProfile: {} },
            signerParams: { extKeyUsageOids: keyTypes.includes('SIGN') ? ['1.3.6.1.5.5.7.3.4'] : [] },
            locale: 'ru',
          },
        }),
      );
    };

    socket.onmessage = (event) => {
      let payload: NcaLayerResponse;
      try {
        payload = JSON.parse(String(event.data)) as NcaLayerResponse;
      } catch {
        cleanup();
        reject(new NcaLayerError('NCALayer прислал непонятный ответ'));
        return;
      }
      // Диалект ответа отличается между версиями NCALayer, поэтому принимаем оба
      // известных вида — разбор изолирован здесь, как формат моста eGov в драйвере.
      const status = payload.status ?? (payload.code === '200' || payload.code === 200);
      const cms =
        payload.body?.result?.[0] ??
        (typeof payload.body?.result === 'string' ? payload.body.result : undefined) ??
        payload.responseObject;

      cleanup();
      if (status === false || !cms) {
        const message = payload.message ?? payload.body?.message ?? 'Подпись отменена';
        reject(new NcaLayerError(message, /отмен|cancel|closed/i.test(message)));
        return;
      }
      resolve(String(cms));
    };

    socket.onerror = () => {
      cleanup();
      reject(
        new NcaLayerError(
          'NCALayer не запущен или не установлен. Скачайте его на pki.gov.kz, запустите и повторите',
        ),
      );
    };
  });
}

interface NcaLayerResponse {
  status?: boolean;
  code?: string | number;
  message?: string;
  responseObject?: string;
  body?: { result?: string[] | string; message?: string };
}
