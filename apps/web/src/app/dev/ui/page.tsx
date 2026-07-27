'use client';

// ============================================================
// /dev/ui — живой каталог UI-кита. ТОЛЬКО development: в проде роут
// отдаёт 404 и ниоткуда не линкуется (правило «no placeholder UI»).
//
// Здесь каждый примитив показан во ВСЕХ состояниях. Это и витрина, и
// проверка: если компонент сломался, видно тут, а не на 47 страницах.
// ============================================================

import { notFound } from 'next/navigation';
import { useState } from 'react';
import {
  Alert, AvatarStack, Badge, BentoGrid, Button, Calendar, Card, CardHeader, Checkbox, Chip,
  ConfirmDialog, DatePicker, Divider, Dropzone, EmojiIcon, EmptyState, GradientTickBar, Icon,
  IconButton, ICONS, Input, Menu, Modal, PageHeader, Pagination, SearchField, SegmentedControl,
  Select, Skeleton, Spinner, StatTile, StatusDot, Tabs, Textarea, TickBar, Toggle, Tooltip,
  type IconName, type Tone,
} from '@/components/ui';

const TONES: Tone[] = ['accent', 'success', 'warning', 'danger', 'neutral'];

export default function DevUiPage() {
  if (process.env.NODE_ENV !== 'development') notFound();

  const [seg, setSeg] = useState('overview');
  const [tab, setTab] = useState('all');
  const [sel, setSel] = useState<string | null>('medium');
  const [page, setPage] = useState(2);
  const [date, setDate] = useState<Date | null>(null);
  const [calDate, setCalDate] = useState<Date | null>(new Date());
  const [toggles, setToggles] = useState({ alerts: true, scale: false, tfa: true });
  const [checked, setChecked] = useState(true);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [search, setSearch] = useState('');
  const [alerts, setAlerts] = useState({ success: true, warning: true, danger: true });
  const [files, setFiles] = useState<string[]>([]);
  const [progress, setProgress] = useState(68);
  const [filters, setFilters] = useState<Set<string>>(new Set(['todo']));

  function toggleFilter(k: string) {
    setFilters((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }

  return (
    <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto', padding: 'var(--spacing-8) var(--spacing-6) var(--spacing-16)' }}>
      <PageHeader
        breadcrumb="Разработка / Дизайн-система"
        title="UI-кит"
        chip={<Chip tone="accent" icon="spark">Organic Bento</Chip>}
        description="Каталог примитивов во всех состояниях. Страницам запрещено рисовать свои — если чего-то не хватает, компонент добавляется сюда."
        actions={<Button variant="primary" icon="add" onClick={() => setModal(true)}>Открыть модалку</Button>}
      />

      <BentoGrid>
        {/* ---------- Кнопки ---------- */}
        <Card span={6}>
          <CardHeader title="Кнопки" subtitle="4 вида × 3 размера + состояния" />
          <Row>
            <Button variant="primary" icon="add">Основная</Button>
            <Button variant="matte" icon="check">Матовая</Button>
            <Button variant="outline" icon="filter">Контурная</Button>
            <Button variant="ghost" icon="close">Призрачная</Button>
          </Row>
          <Row>
            {TONES.map((t) => (
              <Button key={t} variant="matte" tone={t} size="sm">{t}</Button>
            ))}
          </Row>
          <Row>
            <Button size="sm" variant="primary">Мелкая</Button>
            <Button size="md" variant="primary">Средняя</Button>
            <Button size="lg" variant="primary">Крупная</Button>
          </Row>
          <Row>
            <Button variant="primary" loading>Загрузка</Button>
            <Button variant="primary" disabled>Выключена</Button>
            <Button variant="matte" tone="danger" icon="delete">Удалить</Button>
            <Button variant="ghost" iconRight="caretRight">Дальше</Button>
          </Row>
          <Row>
            <IconButton icon="add" label="Добавить" />
            <IconButton icon="bell" label="Уведомления" />
            <IconButton icon="filter" label="Фильтр" variant="outline" round={false} size={36} />
            <IconButton icon="delete" label="Удалить" variant="danger" />
            <IconButton icon="more" label="Ещё" disabled />
            <Tooltip content="Подсказка появляется через 350 мс">
              <span><IconButton icon="info" label="Справка" /></span>
            </Tooltip>
            <Menu
              items={[
                { key: 'edit', label: 'Изменить', icon: 'edit' },
                { key: 'copy', label: 'Дублировать', icon: 'copy' },
                { key: 'del', label: 'Удалить', icon: 'delete', danger: true, separatorBefore: true },
              ]}
            />
          </Row>
        </Card>

        {/* ---------- Поля ---------- */}
        <Card span={6}>
          <CardHeader title="Поля ввода" />
          <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            <Input label="Название" placeholder="Например, Квартальный отчёт" />
            <Input label="Телефон" icon="device" placeholder="+7 700 000 00 00" hint="Только казахстанский мобильный" />
            <Input label="Сумма" placeholder="0" error="Введите число больше нуля" defaultValue="абв" />
            <Input label="Заблокировано" placeholder="Недоступно" disabled />
            <Select
              label="Приоритет"
              value={sel}
              onChange={setSel}
              options={[
                { value: 'low', label: 'Низкий', color: 'var(--muted)' },
                { value: 'medium', label: 'Средний', color: 'var(--primary)' },
                { value: 'high', label: 'Высокий', color: 'var(--warning-base)' },
                { value: 'urgent', label: 'Срочно', color: 'var(--danger-base)', hint: 'до конца дня' },
                { value: 'none', label: 'Недоступный вариант', disabled: true },
              ]}
            />
            <Textarea label="Описание" placeholder="Пара предложений о задаче" rows={3} />
            <div>
              <span className="ui-field-label">Поиск</span>
              <SearchField value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} placeholder="Поиск…" width="100%" />
            </div>
          </div>
        </Card>

        {/* ---------- Чипы ---------- */}
        <Card span={4}>
          <CardHeader title="Чипы и метки" />
          <Row>
            <Chip tone="success" icon="checkCircle">Активен</Chip>
            <Chip tone="warning" icon="pending">На паузе</Chip>
            <Chip tone="danger" icon="warningCircle">Просрочен</Chip>
            <Chip tone="accent" icon="inProgress">В работе</Chip>
            <Chip tone="neutral">Черновик</Chip>
          </Row>
          <Row>
            <Chip size="sm" tone="accent">Мелкий</Chip>
            <Chip tone="neutral" emoji="🎯">С эмодзи</Chip>
            <Chip tone="accent" onRemove={() => {}}>Убираемый</Chip>
          </Row>
          <Divider />
          <div className="label-caps" style={{ marginBottom: '0.5rem' }}>Чипы-фильтры</div>
          <Row>
            {[
              { k: 'todo', l: 'К выполнению', t: 'neutral' as Tone },
              { k: 'progress', l: 'В работе', t: 'accent' as Tone },
              { k: 'review', l: 'На проверке', t: 'warning' as Tone },
              { k: 'done', l: 'Готово', t: 'success' as Tone },
            ].map((f) => (
              <Chip key={f.k} tone={f.t} selected={filters.has(f.k)} onClick={() => toggleFilter(f.k)}>{f.l}</Chip>
            ))}
          </Row>
          <Divider />
          <Row>
            <Badge>3</Badge>
            <Badge tone="danger">12</Badge>
            <Badge tone="neutral">99+</Badge>
            {TONES.map((t) => <StatusDot key={t} tone={t} title={t} />)}
          </Row>
        </Card>

        {/* ---------- Прогресс ---------- */}
        <Card span={4}>
          <CardHeader title="Штриховой прогресс" subtitle="Фирменный паттерн — сплошных полосок в системе нет" />
          <TickBar label="Выполнено" value={progress} showValue height={16} />
          <div style={{ height: 'var(--spacing-4)' }} />
          <input
            type="range"
            min={0}
            max={100}
            value={progress}
            onChange={(e) => setProgress(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--primary)' }}
            aria-label="Значение прогресса"
          />
          <div style={{ height: 'var(--spacing-4)' }} />
          <TickBar label="Успех" tone="success" value={92} showValue />
          <div style={{ height: 'var(--spacing-3)' }} />
          <TickBar label="Нагрузка" tone="danger" value={92} showValue height={12} />
          <Divider />
          <GradientTickBar label="Уровень риска" value={68} direction="green-red" showValue />
          <div style={{ height: 'var(--spacing-3)' }} />
          <GradientTickBar label="Покрытие мер" value={82} direction="red-green" showValue />
        </Card>

        {/* ---------- Переключатели ---------- */}
        <Card span={4}>
          <CardHeader title="Переключатели" />
          <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            <Toggle
              checked={toggles.alerts}
              onChange={(v) => setToggles((s) => ({ ...s, alerts: v }))}
              label="Уведомления"
              description="Присылать письма о новых задачах"
            />
            <Toggle
              checked={toggles.scale}
              onChange={(v) => setToggles((s) => ({ ...s, scale: v }))}
              label="Авто-масштаб"
              description="Подстраивать сетку под ширину экрана"
            />
            <Toggle
              checked={toggles.tfa}
              onChange={(v) => setToggles((s) => ({ ...s, tfa: v }))}
              label="Подтверждение по SMS"
              description="Код при входе с нового устройства"
            />
            <Divider />
            <Checkbox checked={checked} onChange={setChecked} label="Обычный чекбокс" />
            <Checkbox checked onChange={() => {}} label="Выполненная задача" strikethrough />
            <Checkbox checked={false} onChange={() => {}} label="Заблокирован" disabled />
          </div>
        </Card>

        {/* ---------- Навигация ---------- */}
        <Card span={6}>
          <CardHeader title="Переключатели разделов" />
          <Row>
            <SegmentedControl
              items={[{ key: 'overview', label: 'Обзор' }, { key: 'analytics', label: 'Аналитика' }, { key: 'log', label: 'Журнал' }]}
              value={seg}
              onChange={setSeg}
              aria-label="Режим"
            />
          </Row>
          <div style={{ height: 'var(--spacing-4)' }} />
          <Tabs
            items={[
              { key: 'all', label: 'Все', icon: 'list', count: 42 },
              { key: 'mine', label: 'Мои', icon: 'user', count: 7 },
              { key: 'done', label: 'Готово', icon: 'check' },
              { key: 'arch', label: 'Архив', icon: 'archive', disabled: true },
            ]}
            value={tab}
            onChange={setTab}
            aria-label="Фильтр списка"
          />
          <div style={{ height: 'var(--spacing-5)' }} />
          <Pagination page={page} pageCount={12} onChange={setPage} />
        </Card>

        {/* ---------- Даты ---------- */}
        <Card span={6}>
          <CardHeader title="Даты" />
          <div style={{ display: 'flex', gap: 'var(--spacing-6)', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <DatePicker label="Срок" value={date} onChange={setDate} placeholder="Выберите дату" />
              <div style={{ height: 'var(--spacing-4)' }} />
              <DatePicker label="Только будущее" value={null} onChange={() => {}} min={new Date()} />
            </div>
            <div style={{ flex: '0 0 260px' }}>
              <Calendar value={calDate} onChange={setCalDate} />
            </div>
          </div>
        </Card>

        {/* ---------- Сообщения ---------- */}
        <Card span={5}>
          <CardHeader
            title="Сообщения"
            actions={<IconButton icon="undo" label="Вернуть все" size={32} onClick={() => setAlerts({ success: true, warning: true, danger: true })} />}
          />
          <div className="ui-stack" style={{ gap: 'var(--spacing-3)' }}>
            {alerts.success && <Alert tone="success" onClose={() => setAlerts((s) => ({ ...s, success: false }))}>Изменения сохранены.</Alert>}
            {alerts.warning && <Alert tone="warning" onClose={() => setAlerts((s) => ({ ...s, warning: false }))}>Срок задачи наступает завтра.</Alert>}
            {alerts.danger && <Alert tone="danger" title="Не удалось отправить" onClose={() => setAlerts((s) => ({ ...s, danger: false }))}>Проверьте связь и попробуйте ещё раз.</Alert>}
            <Alert tone="accent" action={<Button size="sm" variant="matte">Открыть</Button>}>Вам открыли доступ к книге «Семья».</Alert>
          </div>
        </Card>

        {/* ---------- Загрузка файлов ---------- */}
        <Card span={7}>
          <CardHeader title="Загрузка файлов" />
          <Dropzone
            onFiles={(f) => setFiles((s) => [...s, ...f.map((x) => x.name)])}
            note="Макс. размер: 20 МБ"
          />
          {files.length > 0 && (
            <div className="ui-stack" style={{ marginTop: 'var(--spacing-4)', gap: '0.5rem' }}>
              {files.map((n, i) => (
                <div key={`${n}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 0.75rem', border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)' }}>
                  <EmojiIcon emoji={null} fallback="file" tone="success" size={30} square />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="title-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</div>
                    <div className="label-caps" style={{ color: 'var(--success)' }}>Готово</div>
                  </div>
                  <IconButton icon="delete" label="Убрать" size={30} variant="danger" onClick={() => setFiles((s) => s.filter((_, j) => j !== i))} />
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ---------- Показатели ---------- */}
        <StatTile span={3} label="Задач сегодня" value="12" icon="tasks" tone="accent" />
        <StatTile span={3} label="Расходы · июль" value="244 530 ₸" icon="finance" tone="warning" trend={{ text: '+14,5% к июню', direction: 'up' }} />
        <StatTile span={3} label="Непрочитанных" value="7" icon="messenger" tone="success" />
        <StatTile span={3} label="Просрочено" value="3" icon="overdue" tone="danger" trend={{ text: '−2 за неделю', direction: 'down' }} />

        {/* ---------- Загрузка и пустота ---------- */}
        <Card span={6}>
          <CardHeader title="Загрузка и пустые состояния" />
          <Row>
            <Spinner />
            <Spinner size={24} />
            <Button variant="matte" loading>Сохраняем</Button>
          </Row>
          <div className="ui-stack" style={{ gap: '0.5rem', margin: 'var(--spacing-4) 0' }}>
            <Skeleton width="40%" height={18} />
            <Skeleton />
            <Skeleton width="70%" />
          </div>
          <Divider />
          <EmptyState
            title="Здесь пока пусто"
            description="Задачи появятся, когда вам их поставят или вы создадите свои."
            action={<Button variant="primary" icon="add">Новая задача</Button>}
          />
        </Card>

        {/* ---------- Аватары и эмодзи ---------- */}
        <Card span={6}>
          <CardHeader title="Аватары и пользовательские эмодзи" subtitle="Эмодзи из БД остаются эмодзи — в матовом круге" />
          <div className="label-caps" style={{ marginBottom: '0.5rem' }}>Стек участников</div>
          <AvatarStack overflow={2}>
            {['А', 'Б', 'В'].map((l) => (
              <span key={l} style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--primary-container)', color: 'var(--primary-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.8rem' }}>{l}</span>
            ))}
          </AvatarStack>
          <Divider />
          <div className="label-caps" style={{ marginBottom: '0.5rem' }}>EmojiIcon — тона</div>
          <Row>
            <EmojiIcon emoji="‍👩‍" tone="accent" />
            <EmojiIcon emoji="🎯" tone="success" />
            <EmojiIcon emoji="💳" tone="warning" square />
            <EmojiIcon emoji="🔥" tone="danger" />
            <EmojiIcon emoji={null} fallback="folder" tone="neutral" />
          </Row>
        </Card>

        {/* ---------- Иконки ---------- */}
        <Card span={12}>
          <CardHeader title={`Иконки — ${Object.keys(ICONS).length} шт.`} subtitle="Phosphor Light. Прямой импорт из пакета в страницах запрещён — только через <Icon name=…>" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '0.5rem' }}>
            {(Object.keys(ICONS) as IconName[]).map((n) => (
              <div
                key={n}
                title={n}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem', padding: '0.6rem 0.3rem', borderRadius: 'var(--radius-md)', background: 'var(--surface-container)' }}
              >
                <Icon name={n} size={20} />
                <span style={{ fontSize: '0.5625rem', fontWeight: 600, color: 'var(--muted)', textAlign: 'center', wordBreak: 'break-word' }}>{n}</span>
              </div>
            ))}
          </div>
        </Card>
      </BentoGrid>

      {/* ---------- Модалки ---------- */}
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Новая задача"
        subtitle="Esc закрывает, Tab не уходит на страницу под окном"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(false)}>Отмена</Button>
            <Button variant="matte" tone="danger" onClick={() => { setModal(false); setConfirm(true); }}>Опасное действие</Button>
            <Button variant="primary" onClick={() => setModal(false)}>Создать</Button>
          </>
        }
      >
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <Input label="Название" placeholder="Что нужно сделать" autoFocus />
          <Textarea label="Описание" rows={3} placeholder="Подробности" />
          <DatePicker label="Срок" value={date} onChange={setDate} />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => setConfirm(false)}
        title="Удалить задачу?"
        message="Действие необратимо: задача и её чат будут удалены."
        confirmLabel="Удалить"
        danger
      />
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.625rem' }}>{children}</div>;
}
