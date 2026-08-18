'use client';

/**
 * Блок «Подписи» на карточке предмета (документ, позже счёт, договор).
 *
 * Показывает, кто подписал, ЧЕМ и когда, даёт подписать тому, кого ждут, и
 * выдаёт артефакты: протокол подписания и экспортный пакет (ст. 62 ЦК РК —
 * подписанный документ обязан жить и вне нашей системы).
 *
 * Уровень подписи назван у КАЖДОЙ строки: простая подпись и ЭЦП — разные вещи,
 * и в списке они не должны выглядеть одинаково.
 */

import { useState } from 'react';
import {
  SIGN_ACT_STATUS_LABELS,
  SIGN_LEVEL_LABELS,
  SIGN_LEVEL_TONE,
  SIGN_METHOD_LABELS,
  type SignSummaryDto,
} from '@superapp/shared';
import { Button, Card, Chip, Icon } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { SignFlowModal } from './SignFlowModal';
import { fetchSignExport, fetchSignProtocol, saveBlob } from './sign-api';

export function SignaturesBlock({
  sign,
  onChanged,
}: {
  sign: SignSummaryDto;
  onChanged?: () => void;
}) {
  const actorOf = (id: string | null) => (id ? sign.actors[id] : undefined);
  const [signing, setSigning] = useState(false);
  const [downloading, setDownloading] = useState<'protocol' | 'export' | null>(null);

  /**
   * Артефакты забираем ОБЫЧНЫМ транспортом с токеном и отдаём файлом. Простая
   * ссылка на ручку API здесь не работает: браузерная навигация не несёт заголовок
   * Authorization, и обе выгрузки отвечали 401.
   */
  const download = async (kind: 'protocol' | 'export') => {
    setDownloading(kind);
    try {
      const blob =
        kind === 'protocol' ? await fetchSignProtocol(sign.requestId) : await fetchSignExport(sign.requestId);
      saveBlob(blob, kind === 'protocol' ? 'Протокол подписания.pdf' : 'Подписано.zip');
    } catch (e) {
      toastError(apiErrorMessage(e));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
        <Icon name="signature" size={18} />
        <b>Подписи</b>
        <Chip tone={SIGN_LEVEL_TONE[sign.level] === 'primary' ? 'accent' : 'neutral'}>
          {SIGN_LEVEL_LABELS[sign.level].short}
        </Chip>
      </div>

      <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
        {sign.acts.map((act) => (
          <div
            key={act.id}
            style={{
              display: 'grid',
              gap: 4,
              padding: 'var(--spacing-2) var(--spacing-3)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-panel)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              {/* Человек в интерфейсе — только карточкой (Принцип 2) */}
              {act.signerUserId ? (
                <PersonChip
                  size="S"
                  userId={act.signerUserId}
                  firstName={actorOf(act.signerUserId)?.firstName ?? act.signerName}
                  lastName={actorOf(act.signerUserId)?.lastName ?? null}
                  avatar={actorOf(act.signerUserId)?.avatar ?? null}
                />
              ) : (
                <span>
                  <Icon name="people" size={14} /> {act.signerName}
                  {act.signerPhoneMasked ? ` · ${act.signerPhoneMasked}` : ''}
                </span>
              )}
              <Chip tone={act.status === 'signed' ? 'success' : act.status === 'pending' ? 'neutral' : 'danger'}>
                {SIGN_ACT_STATUS_LABELS[act.status]}
              </Chip>
            </div>
            {act.status === 'signed' && (
              <div className="body-xs" style={{ opacity: 0.8 }}>
                {act.method ? SIGN_METHOD_LABELS[act.method].title : SIGN_LEVEL_LABELS[act.level].short}
                {act.signedAt ? ` · ${new Date(act.signedAt).toLocaleString('ru-RU')}` : ''}
                {act.certificate?.issuerCn ? ` · ${act.certificate.issuerCn}` : ''}
              </div>
            )}
            {act.declineReason && (
              <div className="body-xs" style={{ color: 'var(--danger-text)' }}>
                Причина: {act.declineReason}
              </div>
            )}
            {act.checkUrl && (
              <a className="body-xs" href={act.checkUrl} target="_blank" rel="noreferrer">
                Проверить подпись
              </a>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        {sign.myActId && (
          <Button variant="primary" icon="signature" onClick={() => setSigning(true)}>
            Подписать
          </Button>
        )}
        {/* Штампованная копия — итоговый PDF с полосами и «Листом подписей»:
            именно этот экземпляр печатают и рассылают (Doodocs-модель). */}
        {sign.stamped?.ready && sign.stamped.url && (
          <Button
            variant="outline"
            icon="file"
            onClick={() => window.open(sign.stamped!.url!, '_blank', 'noopener')}
          >
            Скачать со штампами
          </Button>
        )}
        {sign.canExport && (
          <>
            <Button
              variant="outline"
              icon="docs"
              onClick={() => download('protocol')}
              loading={downloading === 'protocol'}
              disabled={!!downloading}
            >
              Протокол
            </Button>
            <Button
              variant="outline"
              icon="download"
              onClick={() => download('export')}
              loading={downloading === 'export'}
              disabled={!!downloading}
            >
              Пакет с подписями
            </Button>
          </>
        )}
      </div>

      {signing && (
        <SignFlowModal
          requestId={sign.requestId}
          onClose={() => setSigning(false)}
          onSigned={onChanged}
        />
      )}
    </Card>
  );
}
