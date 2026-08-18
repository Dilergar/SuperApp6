'use client';

/**
 * ВНЕШНИЙ ПОДПИСАНТ: страница подписания по гостевой ссылке.
 *
 * Отдельный экран, а не переиспользование `SignFlowModal`: у гостя нет аккаунта
 * и нет обычного транспорта — все действия идут через `POST /share-links/guest/
 * :token/actions/*` с гостевым пропуском в заголовке (перехватчик с редиректом
 * на /login здесь недопустим). Логика та же, клиент другой.
 *
 * Порядок шагов не сокращается: сначала читаем документ, потом принимаем
 * соглашение сторон и согласие на обработку ПД, и только потом приходит код.
 */

import { useEffect, useState } from 'react';
import { SIGN_LEVEL_LABELS, SIGN_METHOD_LABELS, type ShareSignGuestView } from '@superapp/shared';
import { Alert, Button, Checkbox, Icon } from '@/components/ui';
import { CodeInput } from '@/components/verify/CodeInput';
import { NcaLayerError, signWithNcaLayer } from '@/components/sign/ncalayer';
import { shareAction, shareSignPackageUrl, shareVerifyDevCode } from '@/lib/public-api';

// Тип view — ИЗ SHARED (`ShareSignGuestView`): он стоит и у резолвера на API.
// Прежняя локальная копия здесь — ровно тот класс рукописей, который запрещён
// правилом «Контракт API ↔ клиенты».
export type { ShareSignGuestView };

type Screen = 'read' | 'consent' | 'code' | 'qr' | 'done' | 'declined' | 'closed';

/**
 * С чего начать: ВЕРНУВШИЙСЯ подписант попадает сразу на своё состояние.
 *
 * Заявка закрывается тремя разными способами, и «не pending» — не синоним
 * «подписано». Пока все не-pending статусы сводились к экрану «Готово», истёкшая
 * заявка (а ссылка при истечении живёт своей жизнью) встречала контрагента
 * словами «Документ подписан. Ждём подпись другой стороны» — то же самое он видел
 * после отказа НАШЕГО подписанта и после отзыва отправки.
 */
function initialScreen(view: ShareSignGuestView): Screen {
  if (view.myAct?.status === 'signed') return 'done';
  if (view.myAct?.status === 'declined') return 'declined';
  if (view.status === 'pending') return 'read';
  return view.status === 'completed' ? 'done' : 'closed';
}

/** Почему сбор закрыт — словами для того, кого ждали, а не статусом движка */
const CLOSED_TEXT: Record<string, { title: string; hint: string }> = {
  expired: {
    title: 'Срок подписания истёк',
    hint: 'Документ вернулся к отправителю. Если он всё ещё актуален — вам пришлют новую ссылку.',
  },
  declined: {
    title: 'Подписание отменено',
    hint: 'Одна из сторон отказалась подписывать документ. Отправитель об этом знает.',
  },
  cancelled: {
    title: 'Отправитель отозвал документ',
    hint: 'Сбор подписей прекращён. Если документ доработают — вам пришлют новую ссылку.',
  },
};

export function ShareSignView({
  view,
  token,
  session,
  onRefresh,
}: {
  view: ShareSignGuestView;
  token: string;
  session: string;
  onRefresh: () => void;
}) {
  const [screen, setScreen] = useState<Screen>(() => initialScreen(view));
  const [consent, setConsent] = useState(false);
  const [pdConsent, setPdConsent] = useState(false);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [qrData, setQrData] = useState<{ qrDataUrl: string; mock: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async <T,>(key: string, body?: unknown): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await shareAction<T>(token, session, key, body);
    } catch (e) {
      setError(messageOf(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const startPep = async () => {
    const res = await act<{ challengeId: string }>('sign.pep.start', {
      consentAccepted: true,
      pdConsentAccepted: true,
    });
    if (!res) return;
    setChallengeId(res.challengeId);
    setDevCode(await shareVerifyDevCode(res.challengeId));
    setScreen('code');
  };

  const confirmPep = async (value: string) => {
    const res = await act<{ status: string }>('sign.pep.confirm', { challengeId, code: value });
    if (!res) {
      setCode('');
      return;
    }
    setScreen('done');
    onRefresh();
  };

  const startNca = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await (await fetch(view.subject.url)).arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const cms = await signWithNcaLayer({ dataBase64: btoa(binary) });
      const res = await shareAction<{ status: string }>(token, session, 'sign.cms', {
        cms,
        consentAccepted: true,
        pdConsentAccepted: true,
      });
      if (res) {
        setScreen('done');
        onRefresh();
      }
    } catch (e) {
      if (!(e instanceof NcaLayerError && e.cancelled)) setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const startQr = async () => {
    const res = await act<{ qrDataUrl: string; mock: boolean }>('sign.qr.start');
    if (!res) return;
    setQrData(res);
    setScreen('qr');
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
      <div
        style={{
          display: 'grid',
          gap: 4,
          padding: 'var(--spacing-3)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-panel)',
        }}
      >
        <div className="body-sm">{SIGN_LEVEL_LABELS[view.level].full}</div>
        <div className="body-xs" style={{ wordBreak: 'break-all', opacity: 0.7 }}>
          Отпечаток SHA-256: {view.subject.sha256}
        </div>
      </div>

      {/* Документ показываем ЦЕЛИКОМ здесь же: подписывать то, что не открыл, — */}
      {/* именно та практика, из-за которой электронной подписи и не доверяют.   */}
      <iframe
        src={view.subject.url}
        title={view.title}
        style={{ width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 12 }}
      />
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
        {/* Страховка iOS-Safari: PDF в iframe там почти не скроллится — контрагент
            чаще всего открывает ссылку из WhatsApp на телефоне */}
        <Button variant="outline" href={view.subject.url} icon="arrowRight">
          Открыть документ в новой вкладке
        </Button>
        <Button variant="outline" href={view.subject.url} icon="download">
          Скачать документ
        </Button>
      </div>

      {view.signed.length > 0 && (
        <div className="body-sm">
          Уже подписали: {view.signed.map((s) => s.name).join(', ')}
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {screen === 'read' && (
        <Button variant="primary" icon="signature" onClick={() => setScreen('consent')}>
          Перейти к подписанию
        </Button>
      )}

      {screen === 'consent' && (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <ConsentBox text={view.consentText} />
          <Checkbox
            checked={consent}
            onChange={setConsent}
            label="Я прочитал(а) документ и согласен(на) подписать его электронной подписью"
          />
          <ConsentBox text={view.pdConsentText} />
          <Checkbox
            checked={pdConsent}
            onChange={setPdConsent}
            label="Согласен(на) на обработку персональных данных"
          />
          <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
            {view.methods.map((m) => (
              <Button
                key={m}
                variant="outline"
                block
                disabled={!consent || !pdConsent || busy}
                onClick={() => (m === 'pep_otp' ? startPep() : m === 'ncalayer' ? startNca() : startQr())}
                style={{ justifyContent: 'flex-start', height: 'auto', paddingBlock: 'var(--spacing-3)' }}
              >
                <span style={{ display: 'grid', textAlign: 'left', gap: 2 }}>
                  <b>{SIGN_METHOD_LABELS[m].title}</b>
                  <span className="body-xs">{SIGN_METHOD_LABELS[m].hint}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {screen === 'code' && (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <p className="body-sm" style={{ margin: 0 }}>
            Код отправлен на подтверждённый вами номер. Ввод кода = подпись документа.
          </p>
          <CodeInput value={code} onChange={setCode} onComplete={confirmPep} error={!!error} disabled={busy} />
          {devCode && (
            <Alert tone="accent">
              [dev] код: <b>{devCode}</b>
            </Alert>
          )}
        </div>
      )}

      {screen === 'qr' && qrData && (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrData.qrDataUrl}
            alt="QR для подписания в eGov Mobile"
            style={{ width: 220, height: 220, background: '#fff', borderRadius: 12, padding: 8 }}
          />
          <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
            Отсканируйте код в приложении <b>eGov Mobile</b>. После подписания обновите страницу.
          </p>
          <Button variant="ghost" onClick={onRefresh}>
            Обновить
          </Button>
        </div>
      )}

      {screen === 'done' && (
        <DoneScreen view={view} session={session} onRefresh={onRefresh} />
      )}

      {screen === 'closed' && (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)', justifyItems: 'center' }}>
          <Icon name="clock" size={44} />
          <p className="title-sm" style={{ margin: 0 }}>
            {CLOSED_TEXT[view.status]?.title ?? 'Подписание закрыто'}
          </p>
          <p className="body-sm" style={{ margin: 0, textAlign: 'center', opacity: 0.8 }}>
            {CLOSED_TEXT[view.status]?.hint ?? 'Сбор подписей по этому документу прекращён.'}
          </p>
          {view.signed.length > 0 && (
            <div className="body-sm" style={{ textAlign: 'center', opacity: 0.7 }}>
              Успели подписать: {view.signed.map((s) => s.name).join(', ')}
            </div>
          )}
        </div>
      )}

      {screen === 'declined' && (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)', justifyItems: 'center' }}>
          <Icon name="close" size={44} />
          <p className="title-sm" style={{ margin: 0 }}>Вы отказались подписывать</p>
          {view.myAct?.declineReason && (
            <p className="body-sm" style={{ margin: 0, textAlign: 'center' }}>
              Причина: {view.myAct.declineReason}
            </p>
          )}
          <p className="body-sm" style={{ margin: 0, textAlign: 'center', opacity: 0.7 }}>
            Отправитель получил уведомление. Если документ пришлют доработанным — придёт новая ссылка.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Итог для подписанта: статус сбора, кто подписал и СВОЙ экземпляр — штампованный
 * PDF и экспортный пакет (ст. 62 ЦК: документ живёт и у второй стороны). Штамп
 * собирается джобом — до готовности показываем «готовим» и мягко поллим.
 */
function DoneScreen({
  view,
  session,
  onRefresh,
}: {
  view: ShareSignGuestView;
  session: string;
  onRefresh: () => void;
}) {
  const completed = view.status === 'completed';
  const stampedReady = view.stamped?.ready ?? false;

  // Мягкий поллинг готовности штампа: раз в 4с, конечный (10 попыток) — дальше
  // человек жмёт «Проверить снова» сам (урок ревью ссылок: бесконечный опрос
  // с открытой вкладки за ночь давал десятки тысяч запросов).
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (!completed || stampedReady || polls >= 10) return;
    const t = window.setTimeout(() => {
      setPolls((p) => p + 1);
      onRefresh();
    }, 4000);
    return () => window.clearTimeout(t);
  }, [completed, stampedReady, polls, onRefresh]);

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-3)', justifyItems: 'center' }}>
      <Icon name="sealCheck" size={44} />
      <p className="title-sm" style={{ margin: 0 }}>
        {completed ? 'Подписано всеми сторонами' : view.myAct?.status === 'signed' ? 'Ваша подпись поставлена' : 'Документ подписан'}
      </p>
      {!completed && (
        <p className="body-sm" style={{ margin: 0, textAlign: 'center', opacity: 0.8 }}>
          Ждём подпись другой стороны — итоговый документ появится здесь же.
        </p>
      )}
      {view.signed.length > 0 && (
        <div className="body-sm" style={{ textAlign: 'center' }}>
          Подписали: {view.signed.map((s) => s.name).join(', ')}
        </div>
      )}

      {completed &&
        (stampedReady ? (
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
            {/* Обычные <a>-ссылки: файл отдаёт API по гостевому пропуску в адресе */}
            <Button variant="primary" icon="download" href={shareSignPackageUrl(session, 'stamped')}>
              Скачать документ со штампами
            </Button>
            <Button variant="outline" icon="download" href={shareSignPackageUrl(session, 'zip')}>
              Скачать пакет с подписями
            </Button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--spacing-2)', justifyItems: 'center' }}>
            <p className="body-sm" style={{ margin: 0, opacity: 0.8 }}>
              Готовим итоговый документ со штампами…
            </p>
            {polls >= 10 && (
              <Button variant="ghost" size="sm" icon="refresh" onClick={onRefresh}>
                Проверить снова
              </Button>
            )}
          </div>
        ))}
      <p className="body-xs" style={{ margin: 0, textAlign: 'center', opacity: 0.6 }}>
        Подпись проверяется на открытой странице /check — файл при проверке не покидает браузер.
      </p>
    </div>
  );
}

function ConsentBox({ text }: { text: string }) {
  return (
    <div
      className="body-sm"
      style={{
        maxHeight: 160,
        overflowY: 'auto',
        padding: 'var(--spacing-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-panel)',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}

/** Сообщение об ошибке гостевого действия — без раскрытия внутренностей */
function messageOf(err: unknown): string {
  if (err instanceof NcaLayerError) return err.message;
  const response = (err as { response?: { data?: { message?: string } } }).response;
  return response?.data?.message ?? 'Не удалось выполнить действие. Попробуйте ещё раз';
}
