'use client';

// Раздел «Безопасность» профиля (core/audit): плашка cooling новой сессии, устройства и сессии,
// лента активности, пароль и номер (+ автозавершение неактивных сессий), «что мы вам
// присылали», «потеряли телефон?», опасная зона. Сокет `security:changed` перечитывает всё.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AUDIT_LIMITS, type SecurityEventDto } from '@superapp/shared';
import { Alert, BentoGrid, Button, Card, CardHeader, Select } from '@/components/ui';
import { StepUpDialog } from '@/components/verify/StepUpDialog';
import { ChangePasswordDialog, ChangePhoneDialog } from '@/app/profile/[section]/security-dialogs';
import { confirmSecuritySession, fetchSecurityCooling, fetchSecuritySettings, updateSecuritySettings } from '@/lib/audit-api';
import { securityCoolingKey, securityRootKey, securitySettingsKey } from '@/lib/queries';
import { useRealtime } from '@/lib/realtime/useRealtime';
import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { DevicesSessions } from './DevicesSessions';
import { SecurityFeed } from './SecurityFeed';
import { NotMeWizard, freezeUrl } from './NotMeWizard';

const hoursLeft = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 3_600_000));

export function SecuritySection() {
  const t = useTranslations('audit');
  const tp = useTranslations('profile');
  const qc = useQueryClient();
  const [stepUp, setStepUp] = useState(false);
  const [notMe, setNotMe] = useState<SecurityEventDto | null>(null);
  const [dialog, setDialog] = useState<'password' | 'phone' | null>(null);

  const cooling = useQuery({ queryKey: securityCoolingKey, queryFn: fetchSecurityCooling });
  const settings = useQuery({ queryKey: securitySettingsKey, queryFn: fetchSecuritySettings });

  // Событие или сессия изменились (вход с другого устройства, отзыв) — перечитать раздел
  useRealtime({
    onSecurityChanged: () => void qc.invalidateQueries({ queryKey: securityRootKey }),
    onReconnect: () => void qc.invalidateQueries({ queryKey: securityRootKey }),
  });

  const saveIdle = async (days: string | null) => {
    if (!days) return;
    try {
      const res = await updateSecuritySettings({ sessionMaxIdleDays: Number(days) });
      qc.setQueryData(securitySettingsKey, res);
      toast(t('ui.settings.saved'), 'success');
    } catch (err) {
      toastApiError(err);
    }
  };

  const pending = cooling.data && !cooling.data.confirmed;

  return (
    <>
      <BentoGrid>
        {pending && (
          <div style={{ gridColumn: 'span 12' }}>
            <Alert
              tone="waiting"
              icon="clock"
              title={t('ui.cooling.title')}
              action={<Button size="sm" variant="primary" icon="fingerprint" onClick={() => setStepUp(true)}>{t('ui.cooling.confirm')}</Button>}
            >
              {t('ui.cooling.text', { hours: cooling.data?.confirmAt ? hoursLeft(cooling.data.confirmAt) : AUDIT_LIMITS.coolingHours })}
            </Alert>
          </div>
        )}

        <DevicesSessions onNeedConfirm={() => setStepUp(true)} />

        <SecurityFeed onNotMe={setNotMe} />

        <div style={{ gridColumn: 'span 4', display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)', minWidth: 0 }}>
          <Card>
            <CardHeader title={tp('security.passwordPhone')} />
            <p className="label-sm" style={{ margin: '0 0 var(--spacing-4)', lineHeight: 1.5 }}>{tp('security.passwordPhoneText')}</p>
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-4)' }}>
              <Button variant="outline" size="sm" icon="fingerprint" onClick={() => setDialog('password')}>{tp('security.changePassword')}</Button>
              <Button variant="outline" size="sm" icon="device" onClick={() => setDialog('phone')}>{tp('security.changePhone')}</Button>
            </div>
            <Select
              label={t('ui.settings.idle')}
              value={settings.data ? String(settings.data.sessionMaxIdleDays) : null}
              onChange={(v) => void saveIdle(v)}
              options={AUDIT_LIMITS.sessionMaxIdleDaysOptions.map((d) => ({ value: String(d), label: t(`ui.settings.idleDays.${d}`) }))}
            />
          </Card>

          <Card>
            <CardHeader title={t('ui.sent.title')} />
            <p className="label-sm" style={{ margin: '0 0 var(--spacing-3)', lineHeight: 1.5 }}>{t('ui.sent.text')}</p>
            <Button variant="outline" size="sm" icon="bell" href="/notifications?service=security">{t('ui.sent.open')}</Button>
            <p className="label-sm" style={{ margin: 'var(--spacing-3) 0 0', lineHeight: 1.5 }}>{t('ui.sent.never')}</p>
          </Card>

          <Card>
            <CardHeader title={t('ui.lost.title')} />
            <Alert tone="accent" icon="snowflake">{t('ui.lost.text', { url: freezeUrl() })}</Alert>
          </Card>
        </div>

        <Card span={12}>
          <CardHeader title={tp('security.dangerZone')} />
          {/* Удаление = отзыв согласия на обработку ПДн: мастер с блокерами и SMS-подтверждением (core/consents) */}
          <Button variant="outline" tone="danger" href="/account/delete">{tp('security.deleteAccount')}</Button>
        </Card>
      </BentoGrid>

      <StepUpDialog
        open={stepUp}
        purpose="security_confirm"
        onClose={() => setStepUp(false)}
        title={t('ui.cooling.dialogTitle')}
        body={t('ui.cooling.dialogBody')}
        onVerified={async (verifyToken) => {
          await confirmSecuritySession(verifyToken);
          setStepUp(false);
          toast(t('ui.cooling.confirmed'), 'success');
          void qc.invalidateQueries({ queryKey: securityRootKey });
        }}
      />
      {notMe && <NotMeWizard event={notMe} onClose={() => setNotMe(null)} />}
      {dialog === 'password' && <ChangePasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'phone' && <ChangePhoneDialog onClose={() => setDialog(null)} />}
    </>
  );
}
