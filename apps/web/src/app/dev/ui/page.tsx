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
import { HIDDEN, maskedMarker } from '@superapp/shared';
import {
  Alert, AvatarStack, Badge, BarChart, BentoGrid, Button, Calendar, Card, CardHeader, Checkbox, Chip, CohortGrid,
  ConfirmDialog, DatePicker, Divider, Dropzone, EmojiIcon, EmptyState, FunnelChart, GlyphField, GradientTickBar, GuardedValue, Icon,
  IconButton, ICONS, Input, LineChart, Menu, Modal, PageHeader, Pagination, ScatterLabeled, SearchField, SegmentedControl,
  Select, Skeleton, Sparkline, Spinner, StackedBars, StatTile, StatusDot, Table, TableCell, TableGroupRow, TableHeader, TableRow, Tabs,
  Textarea, TickBar, Toggle, Tooltip,
  type BarRow, type CohortRowView, type FunnelStepView, type IconName, type LineSeries, type ScatterPoint, type StackSegment,
  type TableColumn, type Tone,
} from '@/components/ui';

const TONES: Tone[] = ['accent', 'success', 'warning', 'danger', 'waiting', 'neutral'];

// Данные витрины графиков — синтетика, детерминированная (без Math.random: гидрация)
const fmtInt = (v: number) => String(Math.round(v));
const fmtPct = (share: number) => `${Math.round(share * 100)}%`;
const CHART_DAYS = Array.from({ length: 14 }, (_, i) => `${i + 1}`);
const SPARK = [12, 14, 13, 17, 16, 19, 22, 21, 24, 23, 27, 29];
const LINE_SERIES: LineSeries[] = [
  { key: 'tasks', label: 'Задачник', slot: 0, values: CHART_DAYS.map((_, i) => 60 + ((i * 13) % 17)) },
  { key: 'chat', label: 'Мессенджер', slot: 1, values: CHART_DAYS.map((_, i) => 45 + ((i * 11) % 19)) },
  { key: 'cal', label: 'Календарь', slot: 2, values: CHART_DAYS.map((_, i) => 25 + ((i * 5) % 13)) },
  { key: 'prev', label: 'Задачник · прошлый период', slot: 0, dashed: true, values: CHART_DAYS.map((_, i) => 52 + ((i * 7) % 15)) },
];
const BAR_ROWS: BarRow[] = [
  { key: 'tasks', label: 'Задачник', text: 'Задачник', value: 412, previous: 380 },
  { key: 'chat', label: 'Мессенджер', text: 'Мессенджер', value: 356, previous: 390 },
  { key: 'cal', label: 'Календарь', text: 'Календарь', value: 198, previous: 150 },
  { key: 'small', label: 'Малый сервис', text: 'Малый сервис', value: null, masked: true },
];
const STACK_SEGMENTS: StackSegment[] = [
  { key: 'new', label: 'Новые', slot: 0, values: [12, 9, 14, 11, 16, 13, 10, 15] },
  { key: 'current', label: 'Текущие', slot: 1, values: [40, 42, 41, 45, 47, 46, 49, 51] },
  { key: 'returned', label: 'Вернувшиеся', slot: 2, values: [5, 7, 6, 4, 8, 6, 7, 9] },
  { key: 'dormant', label: 'Уснувшие', slot: 5, negative: true, values: [6, 8, 5, 9, 7, 6, 8, 5] },
];
const FUNNEL_STEPS: FunnelStepView[] = [
  { key: 's1', label: 'Открыл регистрацию', count: 1000, fromPrevious: null, fromStart: 1 },
  { key: 's2', label: 'Ввёл номер', count: 720, fromPrevious: 0.72, fromStart: 0.72 },
  { key: 's3', label: 'Подтвердил код', count: 610, fromPrevious: 0.85, fromStart: 0.61 },
  { key: 's4', label: 'Создал первую задачу', count: 240, fromPrevious: 0.39, fromStart: 0.24 },
];
const COHORT_ROWS: CohortRowView[] = [
  { key: 'w1', label: '1 сен', size: 120, masked: false, values: [1, 0.46, 0.31, 0.25, 0.18] },
  { key: 'w2', label: '8 сен', size: 98, masked: false, values: [1, 0.51, 0.34, 0.27, null] },
  { key: 'w3', label: '15 сен', size: 9, masked: true, values: [null, null, null, null, null] },
];
const SCATTER_POINTS: ScatterPoint[] = [
  { key: 'tasks', label: 'Задачник', slot: 0, x: 0.62, y: 14 },
  { key: 'chat', label: 'Мессенджер', slot: 1, x: 0.71, y: 19 },
  { key: 'cal', label: 'Календарь', slot: 2, x: 0.34, y: 8 },
  { key: 'drive', label: 'Диск', slot: 3, x: 0.18, y: 5 },
];

const TABLE_COLUMNS: TableColumn[] = [
  { key: 'who', label: 'Кто', width: 'minmax(160px,1fr)' },
  { key: 'status', label: 'Как оформлен', width: 'max-content', hideOnMobile: true },
  { key: 'shifts', label: 'Смены', title: 'Запланировано / отработано за период', width: 'max-content', align: 'end', hideOnMobile: true },
  { key: 'actions', label: '', width: 'max-content', align: 'end' },
];

export default function DevUiPage() {
  if (process.env.NODE_ENV !== 'development') notFound();

  const [seg, setSeg] = useState('overview');
  const [tab, setTab] = useState('all');
  const [sel, setSel] = useState<string | null>('medium');
  const [page, setPage] = useState(2);
  const [groupOpen, setGroupOpen] = useState(true);
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
  const [glyph, setGlyph] = useState<string | null>('fl:2615');

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
            <Chip tone="waiting" icon="pending">На проверке</Chip>
            <Chip tone="warning" icon="warning">Лимит 80%</Chip>
            <Chip tone="danger" icon="warningCircle">Просрочен</Chip>
            <Chip tone="accent" icon="inProgress">В работе</Chip>
            <Chip tone="neutral">Черновик</Chip>
          </Row>
          <Row>
            <Chip size="sm" tone="accent">Мелкий</Chip>
            <Chip tone="neutral" emoji="🎯">С эмодзи</Chip>
            <Chip tone="accent" onRemove={() => {}}>Убираемый</Chip>
            {/* Клик + крестик: обёртка становится span с двумя кнопками внутри */}
            <Chip tone="neutral" emoji="🍽️" onClick={() => {}} onRemove={() => {}} title="Изменить" removeLabel="Удалить">
              Открыть или убрать
            </Chip>
          </Row>
          <Divider />
          <div className="label-caps" style={{ marginBottom: '0.5rem' }}>Чипы-фильтры</div>
          <Row>
            {[
              { k: 'todo', l: 'К выполнению', t: 'neutral' as Tone },
              { k: 'progress', l: 'В работе', t: 'accent' as Tone },
              { k: 'review', l: 'На проверке', t: 'waiting' as Tone },
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

        {/* ---------- Защищённое поле (core/visibility) ---------- */}
        <Card span={4}>
          <CardHeader title="Защищённое поле" subtitle="<GuardedValue>: значение / маска / скрыто. Маску считает только сервер" />
          <div className="ui-stack" style={{ gap: 'var(--spacing-2)', fontSize: '0.875rem' }}>
            <Row>
              <span className="label-caps" style={{ minWidth: 110 }}>Видно</span>
              <GuardedValue value="+7 705 123 45 67" />
            </Row>
            <Row>
              <span className="label-caps" style={{ minWidth: 110 }}>Маска</span>
              <GuardedValue value={maskedMarker('phone_partial', '+77051234567')} />
            </Row>
            <Row>
              <span className="label-caps" style={{ minWidth: 110 }}>Маска + раскрытие</span>
              <GuardedValue
                value={maskedMarker('id_last4', '900101300123', 'one')}
                maskAction={<IconButton icon="eye" size={28} iconSize={16} round={false} label="Показать" onClick={() => {}} />}
              />
            </Row>
            <Row>
              <span className="label-caps" style={{ minWidth: 110 }}>Скрыто</span>
              <span className="label-sm" style={{ opacity: 0.6 }}>(не рисуется)</span>
              <GuardedValue value={HIDDEN} />
            </Row>
            <Row>
              <span className="label-caps" style={{ minWidth: 110 }}>Скрыто, чип</span>
              <GuardedValue value={HIDDEN} placeholder />
            </Row>
          </div>
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
        <StatTile span={4} label="Активные за 7 дней" value="1 284" delta={{ text: '+12,4%', direction: 'up' }} sparkline={<Sparkline values={SPARK} />} />
        <StatTile span={4} label="Отказы на оплате" value="37" delta={{ text: '+8', direction: 'up', good: false }} />
        <StatTile span={4} label="Сессия, медиана" value="6 мин" delta={{ text: 'без изменений', direction: 'flat' }} />

        {/* ---------- Графики ---------- */}
        <Card span={12}>
          <CardHeader title="Графики" subtitle="components/ui/charts: слоты --series-1…6, форма маркера у серии, легенда-чипы, таблица-дублёр под каждым графиком" />
          <LineChart ariaLabel="Линии" labels={CHART_DAYS} series={LINE_SERIES} formatValue={fmtInt} integer />
        </Card>
        <Card span={6}>
          <CardHeader title="Одна серия" subtitle="Заливка под линией, пропуск в данных рвёт линию" />
          <LineChart ariaLabel="Одна серия" labels={CHART_DAYS} series={[{ key: 'gap', label: 'С пропуском', slot: 0, values: CHART_DAYS.map((_, i) => (i === 6 ? null : 40 + ((i * 7) % 23))) }]} formatValue={fmtInt} integer />
        </Card>
        <Card span={6}>
          <CardHeader title="Полосы" subtitle="Скрытое k-анонимностью — «—»" />
          <BarChart
            ariaLabel="Полосы"
            rows={BAR_ROWS}
            formatValue={fmtInt}
            maskedHint="Меньше 20 — скрыто ради приватности"
            previousLabel="Прошлый период"
            columns={['Сервис', 'Люди']}
          />
        </Card>
        <Card span={6}>
          <CardHeader title="Состав во времени" subtitle="Уснувшие — вниз от нуля" />
          <StackedBars ariaLabel="Состав" labels={CHART_DAYS.slice(0, 8)} segments={STACK_SEGMENTS} formatValue={fmtInt} />
        </Card>
        <Card span={6}>
          <CardHeader title="Воронка" subtitle="Самый большой отвал подсвечен" />
          <FunnelChart
            ariaLabel="Воронка"
            steps={FUNNEL_STEPS}
            biggestDropIndex={2}
            formatNumber={fmtInt}
            formatPercent={fmtPct}
            dropLabel={(d) => `отвал ${fmtPct(d)}`}
            columns={['Шаг', 'Люди', 'Конверсия']}
          />
        </Card>
        <Card span={6}>
          <CardHeader title="Когорты" subtitle="Шкала светлоты одного тона" />
          <CohortGrid
            ariaLabel="Когорты"
            columns={['0', '1', '7', '14', '30']}
            rows={COHORT_ROWS}
            formatPercent={fmtPct}
            formatNumber={fmtInt}
            maskedHint="Меньше 20 — скрыто ради приватности"
            headers={{ cohort: 'Когорта', size: 'Люди' }}
          />
        </Card>
        <Card span={6}>
          <CardHeader title="Точки с подписями" subtitle="Две величины без второй оси" />
          <ScatterLabeled ariaLabel="Точки" points={SCATTER_POINTS} xLabel="Доля людей" yLabel="Дней в месяц" formatX={fmtPct} formatY={fmtInt} height={240} />
        </Card>

        {/* ---------- Таблица ---------- */}
        <Card span={12}>
          <CardHeader
            title="Таблица"
            subtitle="<Table lines>: общая сетка колонок (subgrid), линии между строками и колонками; группа сворачивается, итоги — строкой footer"
          />
          <div style={{ overflowX: 'auto' }}>
            <Table columns={TABLE_COLUMNS} lines className="density-compact" aria-label="Пример таблицы">
              <TableHeader />
              <TableGroupRow rowIndex={2} expanded={groupOpen} onToggle={() => setGroupOpen((v) => !v)} toggleLabel="«Бариста»">
                <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>Бариста</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <TickBar value={67} tone="warning" height={6} style={{ width: 96 }} aria-label="Укомплектованность" />
                  <span className="label-sm">2 / 3</span>
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <Button size="sm" variant="ghost">Править</Button>
                </span>
              </TableGroupRow>
              {groupOpen && [
                { name: 'Айгерим', status: <Chip tone="success">Оформлен · ТОО «Утро»</Chip>, shifts: '12 / 11' },
                { name: 'Данияр', status: <Chip tone="warning">Не оформлен</Chip>, shifts: '8 / 8' },
              ].map((r, i) => (
                <TableRow key={r.name} rowIndex={i + 3}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell hideOnMobile>{r.status}</TableCell>
                  <TableCell align="end" hideOnMobile><span className="label-sm">{r.shifts}</span></TableCell>
                  <TableCell align="end"><Button size="sm" variant="ghost">Ставки</Button></TableCell>
                </TableRow>
              ))}
              {groupOpen && (
              <TableRow rowIndex={5}>
                <TableCell><span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}><Chip tone="neutral">Вакантно</Chip><span className="label-sm">с 12.08</span></span></TableCell>
                <TableCell hideOnMobile><span className="label-sm">—</span></TableCell>
                <TableCell align="end" hideOnMobile><span className="label-sm">—</span></TableCell>
                <TableCell align="end"><Button size="sm" variant="outline">Назначить</Button></TableCell>
              </TableRow>
              )}
              <TableRow footer rowIndex={6}>
                <TableCell>Итого · по штату 3 · занято 2</TableCell>
                <TableCell hideOnMobile />
                <TableCell align="end" hideOnMobile>20 / 19</TableCell>
                <TableCell align="end" />
              </TableRow>
            </Table>
          </div>
        </Card>

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
          <Divider />
          {/* Три набора рядом: один и тот же смысл, разные каталоги */}
          <div className="label-caps" style={{ marginBottom: '0.5rem' }}>Glyph — иконка каталога · Fluent · Noto · легаси-эмодзи</div>
          <Row>
            <EmojiIcon emoji="ph:car" tone="neutral" />
            <EmojiIcon emoji="fl:1f697" tone="neutral" />
            <EmojiIcon emoji="nt:1f697" tone="neutral" />
            <EmojiIcon emoji="🚗" tone="neutral" />
            <Chip size="sm" emoji="ph:coffee">иконка в чипе</Chip>
            <Chip size="sm" emoji="fl:2615">Fluent в чипе</Chip>
          </Row>
          <Divider />
          <div className="label-caps" style={{ marginBottom: '0.5rem' }}>GlyphField — выбор значка</div>
          <Row>
            <GlyphField value={glyph} onChange={setGlyph} suggest="кофе" />
            <div className="body-sm" style={{ alignSelf: 'center' }}>
              значение: <code>{glyph ?? '—'}</code>
            </div>
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
