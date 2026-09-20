'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  ENTITLEMENT_REGISTRY,
  ENTITLEMENT_SUBJECT_TYPES,
  PLATFORM_ERROR_CODES,
  PLATFORM_LIMITS,
  isEntitlementKey,
  type PlatformCommandDto,
  type PlatformCommandPreviewDto,
  type PlatformCommandResultDto,
  type PlatformRisk,
} from '@superapp/shared';
import { Alert, Button, Chip, DatePicker, Input, Modal, Select, Textarea, Toggle, type Tone } from '@/components/ui';
import { apiErrorDetails, apiErrorMessage } from '@/lib/platform-api';
import { previewPlatformCommand, runPlatformCommand, platformRootKey } from '@/lib/platform/api';
import { toastApiError } from '@/lib/api-errors';
import { toast } from '@/lib/toast';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { StepUpModal } from './StepUpModal';

// ============================================================
// Исполнитель команд — ОДНА модалка на все команды реестра: поля из JSON-схемы входа,
// чип риска, обязательная причина у high/critical, предпросмотр у dryRun, перехваты:
// 403 step_up_required → OTP → повтор с тем же идемпотентным ключом; `pending`
// (dual control) → тост со ссылкой на «Заявки»; успех → тост + инвалидация.
// Двойной клик безопасен идемпотентным ключом (генерируется при открытии).
// ============================================================

export const RISK_TONE: Record<PlatformRisk, Tone> = { low: 'neutral', medium: 'accent', high: 'warning', critical: 'danger' };

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  format?: string;
  anyOf?: JsonSchema[];
  description?: string;
};

type FormValue = string | number | boolean | null | Record<string, unknown> | unknown[];

function unwrap(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  if (schema.anyOf) {
    const nonNull = schema.anyOf.filter((s) => s.type !== 'null');
    return { schema: nonNull[0] ?? schema, nullable: nonNull.length !== schema.anyOf.length };
  }
  if (Array.isArray(schema.type)) {
    return { schema: { ...schema, type: schema.type.find((t) => t !== 'null') }, nullable: schema.type.includes('null') };
  }
  return { schema, nullable: false };
}

function isSubjectSchema(schema: JsonSchema): boolean {
  return schema.type === 'object' && !!schema.properties?.type && !!schema.properties?.id;
}

/**
 * Значение тарифного ключа — union «число | да/нет | без ограничения». Обычное
 * `unwrap` схлопнуло бы его в число: фичу (boolean) задать было бы нельзя, а пустое
 * поле молча уезжало бы как `null`, то есть «без ограничения». Поэтому такой вход
 * рисуется выбором режима, и «без ограничения» — осознанный пункт списка.
 */
function isTriValueSchema(raw: JsonSchema): boolean {
  // Zod-union приезжает ДВУМЯ формами: списком типов (`type: ['number','boolean','null']`)
  // и `anyOf` — детектор обязан знать обе, иначе поле молча остаётся числовым.
  const types = new Set<string | undefined>(Array.isArray(raw.type) ? raw.type : (raw.anyOf ?? []).map((s) => (Array.isArray(s.type) ? s.type[0] : s.type)));
  return types.has('number') && types.has('boolean');
}

type ValueMode = 'number' | 'yes' | 'no' | 'unlimited';

function modeOfValue(v: FormValue): ValueMode | null {
  if (typeof v === 'number') return 'number';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v === null) return 'unlimited';
  return null;
}

function randomKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function CommandRunner({
  command,
  open,
  onClose,
  initialInput,
  onDone,
}: {
  command: PlatformCommandDto;
  open: boolean;
  onClose: () => void;
  initialInput?: Record<string, unknown>;
  onDone?: (result: PlatformCommandResultDto) => void;
}) {
  const t = useTranslations('platform');
  const te = useTranslations('entitlements');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { me } = usePlatformAuth();
  const [values, setValues] = useState<Record<string, FormValue>>({});
  // Подписи полей и значений enum — из каталога, без «MISSING_MESSAGE» в консоли:
  // ключ реестра тарифов и план подписываются словарём тарифов, прочее — по имени поля
  const fieldLabel = (name: string) => (t.has(`fields.${name}`) ? t(`fields.${name}`) : name);
  const enumLabel = (name: string, opt: string): string => {
    if (name === 'key' && isEntitlementKey(opt)) return te(ENTITLEMENT_REGISTRY[opt].labelKey.replace(/^entitlements\./, ''));
    if (name === 'planKey' && te.has(`plans.${opt}`)) return te(`plans.${opt}`);
    const map: Record<string, string> = { role: 'roles', status: 'subscriptionStatus', source: 'grantSource', mode: 'overrideMode', entity: 'card' };
    const ns = map[name];
    return ns && t.has(`${ns}.${opt}`) ? t(`${ns}.${opt}`) : opt;
  };
  const [reason, setReason] = useState('');
  const [ticketRef, setTicketRef] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(randomKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PlatformCommandPreviewDto | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [pendingRetry, setPendingRetry] = useState(false);

  const schema = command.inputSchema as JsonSchema;
  const props = useMemo(() => Object.entries(schema.properties ?? {}), [schema]);
  const required = new Set(schema.required ?? []);
  // Причина одна на форму: если вход команды сам несёт поле `reason` (оверрайды, гранты),
  // оно не рисуется отдельно — в него уходит та же причина, что и в журнал
  const schemaHasReason = !!schema.properties?.reason;
  // Обязательность причины решает СЕРВЕР (паспорт команды): дублировать правило ключом
  // команды значит однажды разойтись с исполнителем.
  const needsReason = command.reasonRequired || (schemaHasReason && required.has('reason'));
  const showReason = needsReason || schemaHasReason;
  // «Второй сотрудник одобряет» — по живой политике, а не по флагу команды
  const dualControlLive = !!command.dualControl && !!me?.policy.dualControlEnabled;

  useEffect(() => {
    if (!open) return;
    const init: Record<string, FormValue> = {};
    for (const [name, raw] of props) {
      const { schema: s } = unwrap(raw);
      const given = initialInput?.[name];
      if (given !== undefined) init[name] = given as FormValue;
      else if (s.type === 'boolean') init[name] = false;
      else if (isSubjectSchema(s)) init[name] = { type: 'user', id: '' };
      else init[name] = '';
    }
    setValues(init);
    setReason('');
    setTicketRef('');
    setIdempotencyKey(randomKey());
    setError('');
    setPreview(null);
  }, [open, props, initialInput]);

  const setField = (name: string, v: FormValue) => setValues((prev) => ({ ...prev, [name]: v }));

  /** Собрать вход: пустые строки необязательных полей не отправляем; JSON-текст разбираем. */
  const buildInput = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, raw] of props) {
      const { schema: s, nullable } = unwrap(raw);
      const v = values[name];
      if (v === '' || v === undefined) {
        // `null` подставляем только там, где пустота ЗНАЧИТ «снять» (ссылка на версию
        // плана). У значения тарифного ключа пустота значит «не выбрано» — пусть
        // сервер отвергнет вход, а не примет молчаливый безлимит.
        if (nullable && required.has(name) && !isTriValueSchema(raw)) out[name] = null;
        continue;
      }
      if (s.type === 'number' || s.type === 'integer') out[name] = typeof v === 'number' ? v : Number(v);
      else if ((s.type === 'object' && !isSubjectSchema(s)) || s.type === 'array') {
        out[name] = typeof v === 'string' ? JSON.parse(v) : v;
      } else out[name] = v;
    }
    if (schemaHasReason && reason.trim()) out.reason = reason.trim();
    return out;
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    let input: Record<string, unknown>;
    try {
      input = buildInput();
    } catch {
      setError(t('runner.badJson'));
      setBusy(false);
      return;
    }
    try {
      const res = await runPlatformCommand(command.key, { input, idempotencyKey, reason: reason || undefined, ticketRef: ticketRef || undefined });
      if (res.status === 'pending') toast(t('runner.pending'), 'info');
      else toast(t('runner.done'), 'success');
      void qc.invalidateQueries({ queryKey: platformRootKey });
      onDone?.(res);
      onClose();
    } catch (err) {
      const code = apiErrorDetails(err)?.code;
      if (isAxiosError(err) && err.response?.status === 403 && code === PLATFORM_ERROR_CODES.stepUpRequired) {
        setPendingRetry(true);
        setStepUp(true);
      } else {
        setError(apiErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async () => {
    setBusy(true);
    setError('');
    try {
      setPreview(await previewPlatformCommand(command.key, buildInput()));
    } catch (err) {
      setError(err instanceof SyntaxError ? t('runner.badJson') : apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reasonShort = needsReason && reason.trim().length < PLATFORM_LIMITS.reasonMinLength;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t(command.titleKey.replace(/^platform\./, ''))}
        subtitle={command.descriptionKey ? t(command.descriptionKey.replace(/^platform\./, '')) : undefined}
        size="md"
        footer={
          <>
            {command.dryRun && (
              <Button variant="outline" loading={busy} onClick={() => void doPreview()}>
                {t('runner.preview')}
              </Button>
            )}
            <Button variant="primary" tone={command.risk === 'critical' ? 'danger' : 'accent'} loading={busy} disabled={reasonShort} onClick={() => void submit()}>
              {t('runner.run')}
            </Button>
          </>
        }
      >
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            <Chip tone={RISK_TONE[command.risk]} size="sm">{t(`risk.${command.risk}`)}</Chip>
            {command.stepUp && <Chip tone="neutral" size="sm" icon="shield">{t('runner.needsStepUp')}</Chip>}
            {dualControlLive && <Chip tone="neutral" size="sm" icon="people">{t('runner.dualControl')}</Chip>}
          </div>

          {props.map(([name, raw]) => {
            if (name === 'reason' && schemaHasReason) return null;
            const { schema: s, nullable } = unwrap(raw);
            const label = `${fieldLabel(name)}${required.has(name) && !nullable ? ' *' : ''}`;
            const v = values[name];
            if (isTriValueSchema(raw)) {
              const mode = modeOfValue(v);
              return (
                <div key={name} style={{ display: 'grid', gridTemplateColumns: mode === 'number' ? 'minmax(10rem, 1fr) 1fr' : '1fr', gap: 'var(--spacing-3)' }}>
                  <Select
                    label={label}
                    value={mode}
                    onChange={(next) => setField(name, next === 'number' ? 0 : next === 'yes' ? true : next === 'no' ? false : null)}
                    options={(['number', 'yes', 'no', 'unlimited'] as ValueMode[]).map((m) => ({ value: m, label: t(`runner.valueMode.${m}`) }))}
                    placeholder={t('runner.choose')}
                  />
                  {mode === 'number' && (
                    <Input
                      type="number"
                      label={t('runner.valueNumber')}
                      value={typeof v === 'number' ? String(v) : ''}
                      onChange={(e) => setField(name, e.target.value === '' ? 0 : Number(e.target.value))}
                    />
                  )}
                </div>
              );
            }
            if (isSubjectSchema(s)) {
              const subj = (v && typeof v === 'object' && !Array.isArray(v) ? v : { type: 'user', id: '' }) as { type: string; id: string };
              return (
                <div key={name} style={{ display: 'grid', gridTemplateColumns: 'minmax(8rem, 1fr) 2fr', gap: 'var(--spacing-3)' }}>
                  <Select
                    label={label}
                    value={subj.type}
                    onChange={(next) => setField(name, { ...subj, type: next })}
                    options={ENTITLEMENT_SUBJECT_TYPES.map((k) => ({ value: k, label: t(`subjectTypes.${k}`) }))}
                  />
                  <Input label={t('fields.subjectId')} value={subj.id} onChange={(e) => setField(name, { ...subj, id: e.target.value })} placeholder="uuid" />
                </div>
              );
            }
            if (s.enum) {
              return (
                <Select
                  key={name}
                  label={label}
                  value={typeof v === 'string' && v ? v : null}
                  onChange={(next) => setField(name, next)}
                  options={s.enum.map((opt) => ({ value: opt, label: enumLabel(name, opt) }))}
                  placeholder={t('runner.choose')}
                />
              );
            }
            if (s.type === 'boolean') {
              return <Toggle key={name} label={label} checked={v === true} onChange={(next) => setField(name, next)} />;
            }
            if (s.type === 'number' || s.type === 'integer') {
              return (
                <Input key={name} type="number" label={label} value={v === null || v === undefined ? '' : String(v)} onChange={(e) => setField(name, e.target.value === '' ? '' : Number(e.target.value))} />
              );
            }
            if (s.type === 'string' && s.format === 'date-time') {
              const date = typeof v === 'string' && v ? new Date(v) : null;
              return (
                <DatePicker key={name} label={label} value={date} onChange={(d) => setField(name, d ? d.toISOString() : '')} clearable={nullable || !required.has(name)} />
              );
            }
            if (s.type === 'object' || s.type === 'array') {
              return (
                <Textarea
                  key={name}
                  label={label}
                  rows={5}
                  hint={t('runner.jsonHint')}
                  value={typeof v === 'string' ? v : JSON.stringify(v ?? (s.type === 'array' ? [] : {}), null, 2)}
                  onChange={(e) => setField(name, e.target.value)}
                  style={{ fontFamily: 'var(--font-mono, monospace)' }}
                />
              );
            }
            if (/reason|note|comment/i.test(name)) {
              return <Textarea key={name} label={label} rows={3} value={typeof v === 'string' ? v : ''} onChange={(e) => setField(name, e.target.value)} />;
            }
            return <Input key={name} label={label} value={typeof v === 'string' ? v : ''} onChange={(e) => setField(name, e.target.value)} />;
          })}

          {showReason && (
            <Textarea
              label={needsReason ? `${t('runner.reason')} *` : t('runner.reason')}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint={t('runner.reasonHint', { min: PLATFORM_LIMITS.reasonMinLength, n: reason.trim().length })}
              error={reason.length > 0 && reasonShort ? t('runner.reasonShort', { min: PLATFORM_LIMITS.reasonMinLength }) : null}
            />
          )}
          <Input label={t('runner.ticket')} value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} placeholder={t('runner.ticketPlaceholder')} />

          {error && <Alert tone="danger">{error}</Alert>}

          {preview && (
            <Alert tone="accent" title={t('runner.previewTitle')}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{JSON.stringify({ before: preview.before, after: preview.after, result: preview.result }, null, 2)}</pre>
            </Alert>
          )}
          <p className="label-sm">{tc('a11y.actions')}: {t('runner.idempotent')}</p>
        </div>
      </Modal>
      <StepUpModal
        open={stepUp}
        onClose={() => setStepUp(false)}
        onDone={() => {
          if (pendingRetry) {
            setPendingRetry(false);
            void submit();
          }
        }}
      />
    </>
  );
}

/** Ошибка step-up у произвольного действия (решение заявки и т.п.) */
export function isStepUpRequired(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 403 && apiErrorDetails(err)?.code === PLATFORM_ERROR_CODES.stepUpRequired;
}

export function notifyCommandError(err: unknown): void {
  toastApiError(err);
}
