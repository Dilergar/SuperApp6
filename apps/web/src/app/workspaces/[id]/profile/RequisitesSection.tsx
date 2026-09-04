'use client';

// ============================================================
// Реквизиты организации — блок «Анкеты компании».
//
// Один компонент в двух режимах: правка (анкета, admin+) и чтение (карточка
// компании — сотрудникам, если флаг видимости «Реквизиты» включён; сервер
// в этом случае отвечает data: null, и блок просто не рисуется).
//
// Всё для будущих документов: юрформа, налоговый режим, БИН, юрадрес, КБе,
// НДС, директор из сотрудников, основание подписи, банковские счета списком
// с основным (модель 1С/Odoo — в счёт подставляется основной).
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ORG_FORMS,
  TAX_REGIMES,
  REQUISITE_LIMITS,
  isValidBik,
  isValidIinOrBin,
  isValidKbe,
  isValidKzIban,
  normalizeIban,
  LEGAL_ENTITY_LIMITS,
  type LegalEntityDto,
  type WorkspaceMember,
  type WorkspaceRequisitesDto,
} from '@superapp/shared';
import { Button, Card, CardHeader, Chip, Divider, Input, Select, Toggle, useConfirm } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { legalEntitiesKey, workspaceRequisitesKey } from '@/lib/queries';

const ORG_FORM_LABEL = new Map<string, string>(ORG_FORMS.map((f) => [f.value, f.label]));
const TAX_REGIME_LABEL = new Map<string, string>(TAX_REGIMES.map((r) => [r.value, r.label]));

export type { LegalEntityDto };

export function RequisitesSection({
  workspaceId,
  mode,
  span = 12,
}: {
  workspaceId: string;
  mode: 'edit' | 'view';
  span?: number;
}) {
  const { data, isPending } = useQuery({
    queryKey: workspaceRequisitesKey(workspaceId),
    queryFn: async () =>
      await apiGet<WorkspaceRequisitesDto | null>(`/workspaces/${workspaceId}/requisites`),
  });

  // Скрыто настройкой видимости (сервер отвечает null) либо ещё грузится.
  if (isPending) return null;
  if (!data && mode === 'view') return null;

  return mode === 'edit' ? (
    <RequisitesEditor workspaceId={workspaceId} initial={data ?? null} span={span} />
  ) : (
    <RequisitesView data={data as WorkspaceRequisitesDto} span={span} />
  );
}

// ------------------------------------------------------------
// Чтение (карточка компании — сотрудникам)
// ------------------------------------------------------------

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', gap: 'var(--spacing-3)', fontSize: '0.85rem', lineHeight: 1.6 }}>
      <span style={{ color: 'var(--on-surface-variant)', minWidth: 150 }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function RequisitesView({ data, span }: { data: WorkspaceRequisitesDto; span: number }) {
  const filled =
    data.legalName || data.bin || data.legalAddress || data.orgForm || data.bankAccounts.length > 0;
  if (!filled) return null;
  return (
    <Card span={span}>
      <CardHeader title="Реквизиты" subtitle="Для договоров и счетов" />
      <div className="ui-stack" style={{ gap: 'var(--spacing-1)' }}>
        <Row label="Форма" value={data.orgForm ? (ORG_FORM_LABEL.get(data.orgForm) ?? data.orgForm) : null} />
        <Row label="Юр. наименование" value={data.legalName} />
        <Row label="БИН" value={data.bin} />
        <Row label="Налоговый режим" value={data.taxRegime ? (TAX_REGIME_LABEL.get(data.taxRegime) ?? data.taxRegime) : null} />
        <Row label="Юридический адрес" value={data.legalAddress} />
        <Row label="КБе" value={data.kbe} />
        <Row
          label="НДС"
          value={
            data.vatPayer
              ? `плательщик${data.vatSeries || data.vatNumber ? ` (св-во ${[data.vatSeries, data.vatNumber].filter(Boolean).join(' № ')})` : ''}`
              : null
          }
        />
        <Row
          label="Директор"
          value={data.directorName ? `${data.directorName}${data.signBasis ? ` · на основании ${data.signBasis}` : ''}` : null}
        />
      </div>
      {data.bankAccounts.length > 0 && (
        <>
          <Divider style={{ margin: 'var(--spacing-4) 0' }} />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
            {data.bankAccounts.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>{a.iban}</span>
                <span style={{ color: 'var(--on-surface-variant)' }}>{a.bankName} · БИК {a.bik}</span>
                {a.isPrimary && <Chip tone="success">Основной</Chip>}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------
// Правка (анкета, admin+)
// ------------------------------------------------------------

export function RequisitesEditor({
  workspaceId,
  initial,
  span,
  // Адрес ручек: головное юрлицо доступно и по старому пути /requisites.
  basePath,
  invalidateKeys,
  title = 'Реквизиты',
  subtitle = 'Юрформа, БИН, банк, директор — для договоров и счетов. Видимость сотрудникам — тумблер «Реквизиты» справа',
  // Имя юрлица правится только у неголовных (у головного имя = название организации).
  nameField,
  headerExtra,
}: {
  workspaceId: string;
  initial: WorkspaceRequisitesDto | null;
  span: number;
  basePath?: string;
  invalidateKeys?: readonly unknown[][];
  title?: string;
  subtitle?: string;
  nameField?: { value: string; onChange: (v: string) => void };
  headerExtra?: React.ReactNode;
}) {
  const path = basePath ?? `/workspaces/${workspaceId}/requisites`;
  const accountsPath = `${path}/accounts`;
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [form, setForm] = useState({
    orgForm: initial?.orgForm ?? '',
    taxRegime: initial?.taxRegime ?? '',
    legalName: initial?.legalName ?? '',
    bin: initial?.bin ?? '',
    legalAddress: initial?.legalAddress ?? '',
    kbe: initial?.kbe ?? '',
    vatPayer: initial?.vatPayer ?? false,
    vatSeries: initial?.vatSeries ?? '',
    vatNumber: initial?.vatNumber ?? '',
    vatDate: initial?.vatDate ?? '',
    directorUserId: initial?.directorUserId ?? '',
    signBasis: initial?.signBasis ?? 'Устава',
  });
  const accounts = initial?.bankAccounts ?? [];
  const [accIban, setAccIban] = useState('');
  const [accBank, setAccBank] = useState('');
  const [accBik, setAccBik] = useState('');

  // Сотрудники — для выбора директора (EntitySelector, как передача владения).
  const { data: members } = useQuery({
    queryKey: ['workspaces', workspaceId, 'members', 'director-picker'],
    queryFn: async () => await apiGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),
  });

  const invalidate = () => {
    const keys = invalidateKeys ?? [[...workspaceRequisitesKey(workspaceId)]];
    for (const key of keys) void qc.invalidateQueries({ queryKey: key });
  };

  const save = useMutation({
    mutationFn: async () => {
      await apiPatch(path, {
        ...(nameField ? { name: nameField.value.trim() } : {}),
        orgForm: form.orgForm || null,
        taxRegime: form.taxRegime || null,
        legalName: form.legalName.trim() || null,
        bin: form.bin.trim() || null,
        legalAddress: form.legalAddress.trim() || null,
        kbe: form.kbe.trim() || null,
        vatPayer: form.vatPayer,
        vatSeries: form.vatPayer ? form.vatSeries.trim() || null : null,
        vatNumber: form.vatPayer ? form.vatNumber.trim() || null : null,
        vatDate: form.vatPayer ? form.vatDate || null : null,
        directorUserId: form.directorUserId || null,
        signBasis: form.signBasis.trim() || null,
      });
    },
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const accIbanNorm = normalizeIban(accIban);
  const accOk = isValidKzIban(accIbanNorm) && accBank.trim().length > 0 && isValidBik(accBik.trim().toUpperCase());

  const addAccount = useMutation({
    mutationFn: async () => {
      await apiPost(accountsPath, {
        iban: accIbanNorm,
        bankName: accBank.trim(),
        bik: accBik.trim().toUpperCase(),
      });
    },
    onSuccess: () => {
      setAccIban('');
      setAccBank('');
      setAccBik('');
      void invalidate();
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const makePrimary = useMutation({
    mutationFn: (accId: string) => apiPatch(`${accountsPath}/${accId}`, { isPrimary: true }),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const removeAccount = useMutation({
    mutationFn: (accId: string) => apiDelete(`${accountsPath}/${accId}`),
    onSuccess: () => void invalidate(),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Card span={span}>
      <CardHeader title={title} subtitle={subtitle} actions={headerExtra} />
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {nameField && (
          <Input
            label="Название юрлица"
            placeholder="ТОО «Ромашка»"
            maxLength={LEGAL_ENTITY_LIMITS.nameMaxLength}
            value={nameField.value}
            onChange={(e) => nameField.onChange(e.target.value)}
            hint="Как показывать в списках и выпадашках"
          />
        )}
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <Select
            label="Форма"
            value={form.orgForm}
            onChange={(v) => setForm({ ...form, orgForm: v })}
            options={[{ value: '', label: 'Не указана' }, ...ORG_FORMS.map((f) => ({ value: f.value, label: f.label }))]}
          />
          <Select
            label="Налоговый режим"
            value={form.taxRegime}
            onChange={(v) => setForm({ ...form, taxRegime: v })}
            options={[{ value: '', label: 'Не указан' }, ...TAX_REGIMES.map((r) => ({ value: r.value, label: r.label }))]}
          />
        </div>
        <Input
          label="Полное юридическое наименование"
          placeholder="ТОО «Ромашка»"
          maxLength={REQUISITE_LIMITS.legalNameMaxLength}
          value={form.legalName}
          onChange={(e) => setForm({ ...form, legalName: e.target.value })}
          hint="Название организации в SuperApp6 — это бренд; в договор идёт юрформа"
        />
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <Input
            label="БИН"
            inputMode="numeric"
            placeholder="12 цифр"
            value={form.bin}
            onChange={(e) => setForm({ ...form, bin: e.target.value.replace(/\D/g, '').slice(0, 12) })}
            error={form.bin && !isValidIinOrBin(form.bin) ? 'Не сходится контрольная сумма' : undefined}
          />
          <Input
            label="КБе"
            inputMode="numeric"
            placeholder="17"
            value={form.kbe}
            onChange={(e) => setForm({ ...form, kbe: e.target.value.replace(/\D/g, '').slice(0, 2) })}
            error={form.kbe && !isValidKbe(form.kbe) ? 'Две цифры' : undefined}
          />
        </div>
        <Input
          label="Юридический адрес"
          maxLength={REQUISITE_LIMITS.addressMaxLength}
          value={form.legalAddress}
          onChange={(e) => setForm({ ...form, legalAddress: e.target.value })}
          placeholder="г. Алматы, ул. …, офис …"
        />
        <Toggle
          checked={form.vatPayer}
          onChange={(v) => setForm({ ...form, vatPayer: v })}
          label="Плательщик НДС"
        />
        {form.vatPayer && (
          <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-4)' }}>
            <Input label="Серия свидетельства" value={form.vatSeries} onChange={(e) => setForm({ ...form, vatSeries: e.target.value })} />
            <Input label="Номер свидетельства" value={form.vatNumber} onChange={(e) => setForm({ ...form, vatNumber: e.target.value })} />
            <Input label="Дата свидетельства" type="date" value={form.vatDate} onChange={(e) => setForm({ ...form, vatDate: e.target.value })} />
          </div>
        )}
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)' }}>
          <div>
            <span className="label-sm" style={{ display: 'block', marginBottom: 'var(--spacing-2)', fontWeight: 600 }}>Директор (из сотрудников)</span>
            <EntitySelector
              types={['user']}
              options={(members ?? [])
                .filter((m) => m.role !== 'contractor')
                .map((m) => ({ type: 'user' as const, id: m.userId, title: m.userName, firstName: m.userName }))}
              value={form.directorUserId ? [{ type: 'user', id: form.directorUserId }] : []}
              onChange={(next) => setForm({ ...form, directorUserId: next[next.length - 1]?.id ?? '' })}
              placeholder="Выберите сотрудника…"
            />
          </div>
          <Input
            label="Действует на основании"
            value={form.signBasis}
            maxLength={REQUISITE_LIMITS.signBasisMaxLength}
            onChange={(e) => setForm({ ...form, signBasis: e.target.value })}
            placeholder="Устава"
          />
        </div>
        <div>
          <Button variant="primary" tone="success" icon="save" loading={save.isPending} onClick={() => save.mutate()}>
            Сохранить реквизиты
          </Button>
        </div>

        <Divider style={{ margin: 'var(--spacing-2) 0' }} />

        {/* Банковские счета — список с основным (в документы подставляется основной) */}
        <CardHeader title="Банковские счета" subtitle="Основной подставляется в счета и договоры" />
        {accounts.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.9rem' }}>{a.iban}</div>
              <div className="label-sm" style={{ opacity: 0.7 }}>{a.bankName} · БИК {a.bik}</div>
            </div>
            {a.isPrimary ? (
              <Chip tone="success">Основной</Chip>
            ) : (
              <Button size="sm" variant="ghost" loading={makePrimary.isPending} onClick={() => makePrimary.mutate(a.id)}>
                Сделать основным
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              tone="danger"
              onClick={() =>
                confirm(
                  {
                    title: 'Удалить счёт?',
                    message: `${a.iban} (${a.bankName}) будет удалён из реквизитов.`,
                    confirmLabel: 'Удалить',
                    danger: true,
                  },
                  () => removeAccount.mutateAsync(a.id).then(() => undefined),
                )
              }
            >
              Удалить
            </Button>
          </div>
        ))}
        <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-3)', alignItems: 'end' }}>
          <Input
            label="IBAN"
            placeholder="KZ…"
            value={accIban}
            onChange={(e) => setAccIban(e.target.value)}
            error={accIban && !isValidKzIban(accIbanNorm) ? 'KZ + 18 знаков' : undefined}
          />
          <Input label="Банк" placeholder="Kaspi Bank" maxLength={REQUISITE_LIMITS.bankNameMaxLength} value={accBank} onChange={(e) => setAccBank(e.target.value)} />
          <Input
            label="БИК"
            placeholder="CASPKZKA"
            value={accBik}
            onChange={(e) => setAccBik(e.target.value.toUpperCase().slice(0, 8))}
            error={accBik && !isValidBik(accBik) ? '8 знаков' : undefined}
          />
        </div>
        <div>
          <Button variant="outline" size="sm" icon="add" loading={addAccount.isPending} disabled={!accOk} onClick={() => addAccount.mutate()}>
            Добавить счёт
          </Button>
        </div>
      </div>
      {confirmUI}
    </Card>
  );
}
