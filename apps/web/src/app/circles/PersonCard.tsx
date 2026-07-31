'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Chip,
  Glyph,
  IconButton,
  Input,
  Menu,
  ModalShell,
  SegmentedControl,
  Toggle,
  type MenuAction,
} from '@/components/ui';
import { ROLE_PRESETS } from '@superapp/shared';
// Типы социального графа берём ИЗ ОБЩЕГО ПАКЕТА, а не объявляем свои: локальные
// копии уже разъехались с сервером (в местной `Contact` не было `initiatedBy`),
// и такое расхождение не ловится компилятором — оно просто тихо теряет поля.
import type { CardVisibility, Circle, Contact, PresenceInfo } from '@superapp/shared';
import { presenceStatusLine } from '../messenger/presence-ui';
import { getPresence } from '@/lib/messenger-api';
import { api, apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import type { CardSize, CardSkinRender } from './card-skin';
import {
  DEFAULT_SKIN,
  SIZE_CONFIG,
  RARITY_META,
  CARD_SIZES,
  displayName,
} from './card-skin';
import { usePersonSkin } from '@/lib/person-skins';
import { callsStatusKey, contactsKey } from '@/lib/queries';
import { getCallsStatus } from '@/lib/calls-api';

// lottie-web (~70KB gz) is loaded ON DEMAND, only when a card with a Lottie effect
// actually renders — a static import shipped it in EVERY route's bundle because
// PersonCard/PersonChip are imported by calendar/messenger/tasks/shop.
const Lottie = dynamic(() => import('lottie-react'), { ssr: false });

// ============================================================
// Types
// ============================================================

interface ProfileData {
  firstName: string;
  lastName: string | null;
  phone: string;
  avatar: string | null;
  dateOfBirth: string | null;
  bio: string | null;
  city: string | null;
  email: string | null;
  maritalStatus: string | null;
  socialLinks: { telegram?: string; instagram?: string } | null;
  cardVisibility: CardVisibility;
}

// Normalized person passed to the renderer (after visibility masking).
interface CardPerson {
  firstName: string;
  lastName: string | null;
  phone: string;
  avatarInitial: string;
  avatar: string | null;
  dateOfBirth: string | null;
  age: number | null;
  city: string | null;
  bio: string | null;
  maritalStatus: string | null;
  email: string | null;
  socialLinks: { telegram?: string; instagram?: string } | null;
  showOnlineStatus: boolean;
  role: string | null;
  presenceLine?: string | null;
}

// ============================================================
// Compact mode props (for circles grid)
// ============================================================

interface CompactProps {
  mode?: 'compact';
  contact: Contact;
  /** Группы владельца («папка» — историческое имя пропа). */
  folders: Circle[];
  activeFolder: string | null;
  onDelete: () => void;
  /** Block this person (confirm + API live in the page handler). */
  onBlock?: () => void;
  onRemoveFromFolder: () => void;
  onAddToFolder: (folderId: string) => void;
  /** Balance of MY currency this person holds (visible to me as the issuer). */
  myCoins?: { icon: string; balance: number } | null;
  /**
   * Присутствие, если оно у вызывающего УЖЕ есть — просто чтобы XL не мигал
   * пустой строкой. Тянуть его для всего грида не нужно: размер L присутствие
   * не показывает, и батч на сотню человек уходил впустую — XL запрашивает
   * присутствие сам, на ОДНОГО человека, в момент открытия.
   */
  presence?: PresenceInfo | null;
  /**
   * Скин, который этот человек надел ДЛЯ МЕНЯ — СИД для первой отрисовки.
   * Живое значение карточка берёт у движка скинов сама (см. CompactCard):
   * иначе снимок страницы переживал бы смену скина.
   */
  skin?: CardSkinRender;
}

// ============================================================
// Full mode props (for profile page)
// ============================================================

interface FullProps {
  mode: 'full';
  profile: ProfileData;
  // When omitted, the card renders read-only — exactly what a viewer in
  // the given segment actually sees (hidden fields are not rendered).
  onToggleVisibility?: (field: keyof CardVisibility, value: boolean) => void;
  /** Skin to preview (Phase 2). Defaults to the free skin. */
  skin?: CardSkinRender;
  /** Initial size for the profile preview. */
  initialSize?: CardSize;
}

type PersonCardProps = CompactProps | FullProps;

// ============================================================
// Component
// ============================================================

// memo: карточки рендерятся гридом на сотню человек, а состояние страницы
// (поиск, форма приглашения) живёт в родителе — без memo каждый кейстрок
// перерисовывал бы все карточки со скинами и эффектами.
export const PersonCard = memo(function PersonCard(props: PersonCardProps) {
  const mode = props.mode || 'compact';
  if (mode === 'full') return <FullCard {...(props as FullProps)} />;
  return <CompactCard {...(props as CompactProps)} />;
});

/**
 * Plain, sized person card (no grid chrome) — reusable wherever a person is shown
 * inline: task pickers (M), mention rows (S), tight spots (XS). Resolves the skin itself.
 */
export const PersonChip = memo(function PersonChip({
  size, userId, firstName, lastName = null, role = null, bio = null, avatar = null,
}: {
  size: CardSize;
  userId?: string | null;
  firstName: string;
  lastName?: string | null;
  role?: string | null;
  bio?: string | null;
  avatar?: string | null;
}) {
  const skin = usePersonSkin(userId) || DEFAULT_SKIN;
  const person: CardPerson = {
    firstName,
    lastName,
    phone: '',
    avatarInitial: (firstName || '?').charAt(0).toUpperCase(),
    avatar,
    dateOfBirth: null, age: null, city: null, bio, maritalStatus: null,
    email: null, socialLinks: null, showOnlineStatus: false, role, presenceLine: null,
  };
  return (
    <CardShell size={size} skin={skin} rotation={0}>
      <CardBody person={person} size={size} skin={skin} />
    </CardShell>
  );
});

// ============================================================
// Card shell — skin-driven container + decoration layers
// ============================================================

function CardShell({
  size, skin, rotation, onClick, onMouseDownCapture, interactive, children, style,
}: {
  size: CardSize;
  skin: CardSkinRender;
  rotation: number;
  onClick?: () => void;
  /** Нужен гварду «клик, закрывший меню, не открывает XL» — см. CompactCard. */
  onMouseDownCapture?: React.MouseEventHandler<HTMLDivElement>;
  interactive?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const cfg = SIZE_CONFIG[size];
  const t = skin.tokens;
  return (
    <div
      className={`person-card-base${interactive ? ' interactive' : ''}`}
      onClick={onClick}
      onMouseDownCapture={onMouseDownCapture}
      style={{
        '--card-rotation': `${rotation}deg`,
        background: skin.backgroundUrl
          ? `url(${skin.backgroundUrl}) center / cover no-repeat, ${t.cardBg}`
          : t.cardBg,
        border: t.cardBorder,
        borderRadius: t.cardRadius,
        boxShadow: t.cardShadow,
        padding: cfg.padding,
        // Row sizes (XS/S/M) are compact chips — hug content, don't stretch to full width.
        display: cfg.layout === 'row' ? 'inline-flex' : undefined,
        alignItems: cfg.layout === 'row' ? 'center' : undefined,
        verticalAlign: cfg.layout === 'row' ? 'middle' : undefined,
        maxWidth: '100%',
        overflow: 'visible',
        ...style,
      } as React.CSSProperties}
    >
      {cfg.effect !== 'none' && (
        skin.effectUrl && cfg.effect === 'full' ? (
          <LottieEffect url={skin.effectUrl} preset={t.effectPreset ?? null} level={cfg.effect} accent={t.accent} />
        ) : t.effectPreset ? (
          <SkinEffect preset={t.effectPreset} level={cfg.effect} accent={t.accent} />
        ) : null
      )}
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
      {skin.frameUrl && (
        <img
          src={skin.frameUrl}
          alt=""
          aria-hidden
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            borderRadius: 'inherit', pointerEvents: 'none', zIndex: 2, objectFit: 'fill',
          }}
        />
      )}
    </div>
  );
}

// Real Lottie effect layer — takes precedence over CSS presets. Respects
// prefers-reduced-motion, and is gated by an IntersectionObserver: the JSON is fetched
// and the animation mounted ONLY while the card is (near) the viewport — a 100+ person
// grid no longer runs 100+ animations off-screen (the deferred F2 perf issue).
function LottieEffect({ url, preset, level, accent }: {
  url: string; preset: string | null; level: 'full' | 'subtle' | 'none'; accent: string;
}) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [reduced, setReduced] = useState(false);
  const [inView, setInView] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setReduced(typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }, []);

  useEffect(() => {
    if (reduced) return;
    const el = hostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true); // no IO support → behave as before
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  useEffect(() => { setData(null); }, [url]);
  useEffect(() => {
    if (reduced || !inView || data) return;
    let ok = true;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error('skin fx fetch failed'); return r.json(); })
      .then((d) => { if (ok) setData(d); })
      .catch(() => {});
    return () => { ok = false; };
  }, [url, inView, reduced, data]);

  if (reduced) return null;
  // Off-screen / until the Lottie JSON resolves (or it errored) → the cheap CSS preset,
  // so a broken/slow effectUrl still renders the skin's built-in effect.
  const fallback = preset ? <SkinEffect preset={preset} level={level} accent={accent} /> : null;
  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {inView && data ? (
        <div className="skin-fx">
          <Lottie animationData={data} loop autoplay style={{ width: '100%', height: '100%' }} />
        </div>
      ) : (
        fallback
      )}
    </div>
  );
}

// Built-in CSS skin effects (fallback when a skin has no Lottie effectUrl).
// `level` scales motion with card size.
function SkinEffect({ preset, level, accent }: {
  preset: string; level: 'full' | 'subtle' | 'none'; accent: string;
}) {
  if (level === 'none') return null;

  if (preset === 'neonGlow') {
    return <div className="skin-fx"><div className="skin-fx-neon" /></div>;
  }

  if (preset === 'petals') {
    const n = level === 'full' ? 7 : level === 'subtle' ? 4 : 2;
    return (
      <div className="skin-fx">
        {Array.from({ length: n }, (_, i) => (
          <span
            key={i}
            className="skin-fx-petal"
            style={{
              left: `${6 + i * (88 / n)}%`,
              width: 6 + (i % 3) * 3,
              height: 6 + (i % 3) * 3,
              background: i % 2 ? '#ffd0e0' : '#f4a8c4',
              animationDelay: `${(i * 0.7).toFixed(2)}s`,
              animationDuration: `${(4 + (i % 4)).toFixed(1)}s`,
            }}
          />
        ))}
      </div>
    );
  }

  if (preset === 'sparkle') {
    const n = level === 'full' ? 9 : level === 'subtle' ? 5 : 3;
    return (
      <div className="skin-fx">
        {Array.from({ length: n }, (_, i) => (
          <span
            key={i}
            className="skin-fx-spark"
            style={{
              left: `${5 + i * (90 / n)}%`,
              top: `${10 + (i * 37) % 78}%`,
              background: accent,
              animationDelay: `${(i * 0.4).toFixed(2)}s`,
              animationDuration: `${(1.6 + (i % 3) * 0.6).toFixed(1)}s`,
            }}
          />
        ))}
      </div>
    );
  }

  return null;
}


// ============================================================
// Card body — avatar + name + fields, sized + skinned
// ============================================================

function CardBody({ person, size, skin, onOpen }: {
  person: CardPerson; size: CardSize; skin: CardSkinRender;
  /** Задаётся только для кликабельной карточки грида — см. комментарий ниже. */
  onOpen?: () => void;
}) {
  const cfg = SIZE_CONFIG[size];
  const t = skin.tokens;
  const showDot = cfg.showPresence && person.showOnlineStatus;

  const nameText = displayName(person.firstName, person.lastName, cfg.fullLastName);
  const nameStyle: React.CSSProperties = {
    fontFamily: t.nameFont, fontSize: cfg.nameSize, fontWeight: 700,
    letterSpacing: '0.04em', color: t.nameColor,
    textTransform: size === 'XS' ? 'none' : 'uppercase',
    textAlign: cfg.layout === 'row' ? 'left' : 'center', lineHeight: 1.1,
    ...(cfg.layout === 'row' ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '12rem' } : {}),
  };

  // Карточку грида нельзя целиком объявить кнопкой — внутри уже есть свои
  // кнопки и ссылки, вышло бы «управление внутри управления». Поэтому носителем
  // действия становится ИМЯ: настоящая кнопка, которую видят клавиатура и
  // скринридер, а сам блок остаётся мышиной целью (его onClick делает то же).
  const nameEl = !cfg.showName ? null : onOpen ? (
    // Кнопка кита, а не своя: состояние :focus-visible инлайн-стилем не
    // выражается вообще, поэтому при табуляции по карточке имя не подсвечивалось.
    // Инлайновые правила перекрывают шрифтовые правила .ui-btn (инлайн > класс),
    // так что вид имени не меняется — приезжают только фокус и клавиатура.
    <Button
      variant="ghost"
      size="sm"
      onClick={onOpen}
      aria-label={`${nameText} — подробнее`}
      style={{
        ...nameStyle,
        background: 'none',
        padding: 0,
        minHeight: 0,
        display: 'block',
        width: '100%',
        whiteSpace: cfg.layout === 'row' ? 'nowrap' : 'normal',
      }}
    >
      {nameText}
    </Button>
  ) : (
    <div style={nameStyle}>{nameText}</div>
  );

  // Row layout — XS (avatar only) / S (avatar+name) / M (avatar+name+role)
  if (cfg.layout === 'row') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: cfg.gap }}>
        <Avatar initial={person.avatarInitial} avatar={person.avatar} size={cfg.avatar} skin={skin} showDot={showDot} />
        {cfg.showName && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', minWidth: 0 }}>
            {nameEl}
            {cfg.showRole && person.role && (
              <div style={{ color: t.metaColor, fontSize: cfg.metaSize, fontWeight: 600 }}>{person.role}</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Stack layout — L (name + bio + role) / XL (everything)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: cfg.gap }}>
      {cfg.showRarity && skin.id !== 'default' && <RarityChip rarity={skin.rarity} />}
      <Avatar initial={person.avatarInitial} avatar={person.avatar} size={cfg.avatar} skin={skin} showDot={showDot} />
      {nameEl}
      {cfg.showPhone && (
        <div style={{ color: t.metaColor, fontSize: cfg.metaSize, textAlign: 'center', marginTop: '-0.2rem' }}>
          {person.phone}
        </div>
      )}
      {cfg.showPresence && person.presenceLine && (
        <div style={{ fontSize: '0.72rem', fontWeight: 600, color: t.accent, textAlign: 'center' }}>
          {person.presenceLine}
        </div>
      )}
      {cfg.fields === 'all' && (
        <CardFields person={person} metaSize={cfg.metaSize} color={t.metaColor} all />
      )}
      {cfg.fields === 'bio' && person.bio && (
        <div style={{ color: t.metaColor, fontSize: cfg.metaSize, textAlign: 'center', fontStyle: 'italic', maxWidth: '200px' }}>
          {person.bio}
        </div>
      )}
      {cfg.showRole && person.role && <RoleBadge role={person.role} skin={skin} size={size} />}
    </div>
  );
}

function CardFields({ person, metaSize, color, all }: {
  person: CardPerson; metaSize: string; color: string; all: boolean;
}) {
  const meta = (children: React.ReactNode, extra?: React.CSSProperties) => (
    <div style={{ color, fontSize: metaSize, textAlign: 'center', ...extra }}>{children}</div>
  );
  const social = person.socialLinks;
  return (
    <>
      {person.dateOfBirth && meta(formatDate(person.dateOfBirth))}
      {person.age !== null && meta(`${person.age} лет`)}
      {person.city && meta(person.city)}
      {person.bio && meta(person.bio, { fontStyle: 'italic', maxWidth: '200px' })}
      {person.maritalStatus && meta(MARITAL_LABELS[person.maritalStatus] || person.maritalStatus)}
      {all && person.email && meta(person.email)}
      {all && social && (social.telegram || social.instagram) && meta(
        <>
          {social.telegram && `TG: ${social.telegram}`}
          {social.telegram && social.instagram && ' · '}
          {social.instagram && `IG: ${social.instagram}`}
        </>,
      )}
    </>
  );
}

function Avatar({ initial, avatar, size, skin, showDot }: {
  initial: string; avatar?: string | null; size: number; skin: CardSkinRender; showDot: boolean;
}) {
  const t = skin.tokens;
  const pad = Math.max(3, Math.round(size * 0.04));
  const inner = avatar ? (
    <img
      src={avatar}
      alt=""
      style={{
        width: size, height: size, borderRadius: t.avatarRadius, border: t.avatarInnerBorder,
        objectFit: 'cover', display: 'block',
      }}
    />
  ) : (
    <div style={{
      width: size, height: size, borderRadius: t.avatarRadius, border: t.avatarInnerBorder,
      background: t.avatarBg, color: t.avatarColor, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 800,
      fontSize: Math.round(size * 0.4), boxShadow: 'inset 0 2px 8px rgba(0, 0, 0, 0.06)',
    }}>
      {initial}
    </div>
  );
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <div style={{
        padding: pad, border: t.avatarRing, display: 'inline-flex',
        borderRadius: t.avatarRadius,
      }}>
        {inner}
      </div>
      {showDot && <OnlineDot />}
    </div>
  );
}

function RoleBadge({ role, skin, size }: { role: string; skin: CardSkinRender; size: CardSize }) {
  const t = skin.tokens;
  const small = size === 'M' || size === 'S' || size === 'XS';
  // span, а не div: в XL бейдж лежит ВНУТРИ кнопки «изменить роль», а содержимое
  // кнопки по спецификации — строчный поток. Вид не меняется (inline-block).
  return (
    <span style={{
      display: 'inline-block', padding: small ? '0.12rem 0.55rem' : '0.3rem 1.2rem',
      background: t.badgeBg, color: t.badgeColor, borderRadius: 'var(--radius-md)',
      fontFamily: 'var(--font-display)', fontSize: small ? '0.62rem' : '0.85rem', fontWeight: 600,
      letterSpacing: '0.03em', boxShadow: t.badgeShadow,
    }}>
      {role}
    </span>
  );
}

function RarityChip({ rarity }: { rarity: CardSkinRender['rarity'] }) {
  const m = RARITY_META[rarity];
  return (
    <div style={{
      display: 'inline-block', padding: '0.1rem 0.6rem', fontSize: '0.62rem', fontWeight: 700,
      fontFamily: 'var(--font-display)', letterSpacing: '0.08em', textTransform: 'uppercase',
      color: m.color, borderRadius: 'var(--radius-sm)',
      boxShadow: `0 0 0 1.5px ${m.color}55, 0 0 0 4px ${m.color}1f`,
    }}>
      {m.label}
    </div>
  );
}

// ============================================================
// Compact card (circles grid) — default size L, click → XL
// ============================================================

function CompactCard({
  contact, folders, activeFolder, onDelete, onBlock, onRemoveFromFolder, onAddToFolder, myCoins, presence, skin,
}: CompactProps) {
  const [expanded, setExpanded] = useState(false);
  // Кнопку «Позвонить» показываем только когда движок звонков включён (не рисуем UI
  // несуществующей фичи). Ключ общий → один сетевой запрос на весь грид.
  const callsEnabled = useQuery({ queryKey: callsStatusKey, queryFn: getCallsStatus, staleTime: 5 * 60 * 1000 }).data?.enabled ?? false;

  // Скин: живое значение движка ВАЖНЕЕ пришедшего пропом. Проп — это снимок,
  // который страница сделала при загрузке; после покупки или смены скина
  // `invalidatePersonSkins()` чистит кэш движка, но чужой снимок достать не может
  // — грид оставался бы на старом скине до перезагрузки. Сети это не стоит
  // ничего: id уже в кэше движка (страница резолвила их через ту же точку).
  const liveSkin = usePersonSkin(contact.them.id);
  const activeSkin = liveSkin || skin || DEFAULT_SKIN;
  const foldersIn = folders.filter((f) => contact.myCircleIds.includes(f.id));

  const seed = contact.linkId.charCodeAt(0) + contact.linkId.charCodeAt(contact.linkId.length - 1);
  const rotation = -0.5 - (seed % 4) * 0.7;

  const person = contactToPerson(contact);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // «Добавить в группу» — меню КИТА: закрытие по клику вне и по Esc, стрелки,
  // портал (не режется overflow карточки). Прежняя самодельная выпадашка не
  // закрывалась ни тем, ни другим, а фокус в неё вообще не заходил.
  const groupItems: MenuAction[] = useMemo(
    () => folders
      .filter((f) => !contact.myCircleIds.includes(f.id))
      .map((f) => ({ key: f.id, label: f.name, onClick: () => onAddToFolder(f.id) })),
    [folders, contact.myCircleIds, onAddToFolder],
  );

  // Клик мимо открытого меню закрывал меню И открывал XL-оверлей поверх него.
  // Чиним снимком на НАЖАТИИ: к моменту click меню уже закрыто своим обработчиком
  // (он слушает mousedown на document), а capture-фаза React проходит раньше —
  // значит в момент mousedown мы ещё видим правду и глушим этот один клик.
  const menuOpenRef = useRef(false);
  const swallowClickRef = useRef(false);

  return (
    <>
      <CardShell
        size="L"
        skin={activeSkin}
        rotation={rotation}
        interactive
        onMouseDownCapture={() => { swallowClickRef.current = menuOpenRef.current; }}
        onClick={() => {
          if (swallowClickRef.current) { swallowClickRef.current = false; return; }
          setExpanded(true);
        }}
      >
        {/* Действия карточки — кнопки кита: у них есть видимый :focus-visible и
            общий ховер. Прежние подделывали ховер мутацией style в onMouseEnter,
            а фокуса не показывали вовсе (инлайн-стилем состояние не выражается). */}
        <div onClick={stop} style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: '0.1rem', alignItems: 'center', zIndex: 3 }}>
          {activeFolder ? (
            <IconButton icon="remove" label="Убрать из группы" size={26} iconSize={14} round={false} onClick={onRemoveFromFolder} />
          ) : groupItems.length > 0 ? (
            <Menu
              items={groupItems}
              label="Добавить в группу"
              trigger={({ ref, onClick, ...aria }) => {
                // Снимок состояния меню для гварда выше. Запись рефа в рендере
                // идемпотентна (то же значение при повторном рендере), а иного
                // способа узнать состояние у кита нет — он держит его в себе.
                menuOpenRef.current = aria['aria-expanded'];
                return (
                  <IconButton
                    ref={ref}
                    icon="add"
                    label="Добавить в группу"
                    size={26}
                    iconSize={14}
                    round={false}
                    onClick={onClick}
                    {...aria}
                  />
                );
              }}
            />
          ) : null}
          {onBlock && (
            <IconButton icon="blocked" label="Заблокировать" size={26} iconSize={14} round={false} onClick={onBlock} />
          )}
          <IconButton
            icon="delete"
            label="Удалить из окружения"
            variant="danger"
            size={26}
            iconSize={14}
            round={false}
            onClick={onDelete}
          />
        </div>

        <CardBody person={person} size="L" skin={activeSkin} onOpen={() => setExpanded(true)} />

        {/* Grid extras — write / call / coins / folders */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)' }}>
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', justifyContent: 'center', flexWrap: 'wrap' }}>
            {/* Это ПЕРЕХОДЫ, поэтому href: Button с href рисует next/link, то есть
                остаётся настоящей ссылкой (правый клик, «в новой вкладке», видно
                куда ведёт), но получает фокус-кольцо и ховер кита.
                stop(e) оставлен — карточка под ними кликабельна, иначе поверх
                открылся бы ещё и XL-оверлей. */}
            <Button href={`/messenger?dm=${contact.them.id}`} onClick={stop} variant="outline" size="sm" icon="messenger">
              Написать
            </Button>
            {callsEnabled && (
              <Button
                href={`/messenger?dm=${contact.them.id}&call=1`}
                onClick={stop}
                variant="outline"
                size="sm"
                icon="call"
                title="Позвонить (аудио; видео включается в звонке)"
              >
                Позвонить
              </Button>
            )}
          </div>
          {myCoins && myCoins.balance !== 0 && (
            <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.72rem', fontWeight: 600, color: 'var(--primary)' }}>
              держит {myCoins.balance.toLocaleString('ru-RU')} <Glyph value={myCoins.icon} size={13} />
            </div>
          )}
          {foldersIn.length > 0 && (
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', justifyContent: 'center' }}>
              {/* Метка — чип кита. Цвет группы это ДАННЫЕ (человек выбрал его сам),
                  поэтому приходит подменой переменных тона, а не своей вёрсткой. */}
              {foldersIn.map((f) => (
                <Chip
                  key={f.id}
                  size="sm"
                  emoji={f.icon}
                  style={f.color ? ({ '--tone-bg': f.color, '--tone-border': f.color } as React.CSSProperties) : undefined}
                >
                  {f.name}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </CardShell>

      {expanded && (
        <ExpandedCard
          person={person}
          skin={activeSkin}
          onClose={() => setExpanded(false)}
          writeHref={`/messenger?dm=${contact.them.id}`}
          callHref={callsEnabled ? `/messenger?dm=${contact.them.id}&call=1` : undefined}
          presenceUserId={contact.them.id}
          initialPresence={presence ?? null}
          // Обе половины модели «взаимные роли»: свою я правлю, чужую — вижу.
          roleEdit={{ linkId: contact.linkId, initialRole: contact.myRole, personName: contact.them.firstName }}
          theirRole={contact.theirRole}
          confirmedAt={contact.confirmedAt}
        />
      )}
    </>
  );
}

/** Контекст правки МОЕЙ роли для человека (только «Моё окружение»). */
interface RoleEditContext {
  /** ContactLink, чью «мою сторону» правим. */
  linkId: string;
  /** Роль, которую я дал человеку сейчас. */
  initialRole: string | null;
  /** Имя человека — для подписи поля. */
  personName: string;
}

// Expanded XL overlay shown when a grid card is clicked.
function ExpandedCard({
  person, skin, onClose, writeHref, callHref, onWrite,
  presenceUserId, initialPresence = null, roleEdit, theirRole, confirmedAt,
}: {
  // Тип элемента выбирается по смыслу, а не по виду:
  //  · известен адрес (Окружение) → writeHref/callHref = настоящая ССЫЛКА
  //    (правый клик, «в новой вкладке», видно куда ведёт);
  //  · сначала нужен запрос (ростер: DM ещё не создан) → onWrite = КНОПКА.
  person: CardPerson; skin: CardSkinRender; onClose: () => void;
  writeHref?: string; callHref?: string; onWrite?: () => void;
  /** XL — единственный размер, который показывает присутствие, и тянет его сам. */
  presenceUserId?: string;
  initialPresence?: PresenceInfo | null;
  /** Правка моей роли; без неё бейдж роли остаётся просто меткой. */
  roleEdit?: RoleEditContext;
  /** Как этот человек называет МЕНЯ — вторая половина «взаимных ролей». */
  theirRole?: string | null;
  /** Когда связь подтвердилась (обе стороны приняли). */
  confirmedAt?: string;
}) {
  const t = skin.tokens;
  const presence = useSinglePresence(presenceUserId, initialPresence);
  const presenceLine = presenceStatusLine(presence);
  const shown: CardPerson = {
    ...person,
    // Роль в XL рисует редактор — иначе бейдж был бы на карточке дважды.
    role: roleEdit ? null : person.role,
    // Пока присутствие не загрузилось, строки нет вовсе: показать «оффлайн»
    // раньше ответа — соврать (человек может быть в сети).
    presenceLine: presenceLine ?? person.presenceLine ?? null,
  };
  return (
    <ModalShell onClose={onClose} zIndex={1000} label={`Карточка: ${person.firstName}`}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', maxWidth: 420, width: '100%' }}>
        <IconButton
          icon="close"
          label="Закрыть"
          onClick={onClose}
          size={32}
          style={{
            position: 'absolute', top: -10, right: -10, zIndex: 5,
            background: 'var(--block)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-pop)',
          }}
        />
        <CardShell size="XL" skin={skin} rotation={-1}>
          <CardBody person={shown} size="XL" skin={skin} />

          {roleEdit && <RoleEditor ctx={roleEdit} skin={skin} />}

          {/* Взаимные роли и дата связи — ядро продукта «Окружение»: сервер отдаёт
              оба поля с самого начала, но карточка показывала только мою сторону. */}
          {(theirRole || confirmedAt) && (
            <div style={{
              marginTop: 'var(--spacing-3)', display: 'flex', flexDirection: 'column',
              gap: '0.15rem', textAlign: 'center', color: t.metaColor, fontSize: '0.78rem',
            }}>
              {theirRole && (
                <div>Он(а) называет вас: <strong style={{ fontWeight: 700 }}>{theirRole}</strong></div>
              )}
              {confirmedAt && <div>В окружении с {formatDate(confirmedAt)}</div>}
            </div>
          )}

          {(writeHref || callHref || onWrite) && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-4)', flexWrap: 'wrap' }}>
              {writeHref
                ? <Button href={writeHref} variant="outline" icon="messenger">Написать</Button>
                : onWrite && <Button variant="outline" icon="messenger" onClick={onWrite}>Написать</Button>}
              {callHref && (
                <Button href={callHref} variant="outline" icon="call" title="Позвонить (аудио; видео включается в звонке)">
                  Позвонить
                </Button>
              )}
            </div>
          )}
        </CardShell>
      </div>
    </ModalShell>
  );
}

/**
 * Присутствие ОДНОГО человека — запрашивается при открытии XL.
 *
 * Почему не React Query: общего ключа в `lib/queries.ts` для присутствия нет, а
 * ключ-литерал в компоненте — это ровно тот молчаливый рассинхрон кэша, от
 * которого ключи и вынесены в один файл. Присутствие живёт секунды и нужно
 * только пока открыт оверлей, поэтому эффект здесь честнее кэша.
 */
function useSinglePresence(userId: string | undefined, initial: PresenceInfo | null): PresenceInfo | null {
  const [presence, setPresence] = useState<PresenceInfo | null>(initial);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    getPresence([userId])
      .then((items) => { if (alive && items.length > 0) setPresence(items[0]); })
      // Сбой — просто нет строки статуса: присутствие украшает карточку, а не
      // несёт её смысл, ронять из-за него оверлей нельзя.
      .catch(() => {});
    return () => { alive = false; };
  }, [userId]);
  return presence;
}

/** Роль по правилам сервера (`roleSchema` в @superapp/shared). */
const ROLE_MAX_LENGTH = 50;

/**
 * Правка МОЕЙ роли для человека. До неё роль задавалась ровно один раз — в
 * приглашении, — и принявший «без предложенных ролей» оставался с пустой
 * подписью навсегда: ручка `PATCH /contacts/:linkId` была, но её никто не звал.
 */
function RoleEditor({ ctx, skin }: { ctx: RoleEditContext; skin: CardSkinRender }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<string | null>(ctx.initialRole);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ctx.initialRole ?? '');
  const [saving, setSaving] = useState(false);

  // Роль могла измениться СНАРУЖИ (перезагрузка окружения) — подхватываем ровно
  // в момент смены пропа. Синхронизировать «всегда, пока поле закрыто» нельзя:
  // сразу после сохранения проп ещё старый (запрос списка только ушёл), и бейдж
  // на секунду откатывался бы к прежней роли.
  const propRoleRef = useRef(ctx.initialRole);
  useEffect(() => {
    if (propRoleRef.current !== ctx.initialRole) {
      propRoleRef.current = ctx.initialRole;
      setRole(ctx.initialRole);
    }
  }, [ctx.initialRole]);

  const save = async (value: string | null) => {
    const next = value === null ? '' : value.trim();
    if (next.length > ROLE_MAX_LENGTH) {
      toastError(`Роль слишком длинная — не больше ${ROLE_MAX_LENGTH} символов`);
      return;
    }
    if (/[<>]/.test(next)) {
      toastError('В роли нельзя использовать символы < и >');
      return;
    }
    setSaving(true);
    try {
      // Правится ТОЛЬКО моя сторона связи: `myRole` — подпись на МОЕЙ карточке,
      // человек её не видит и об изменении не узнаёт.
      await api.patch(`/contacts/${ctx.linkId}`, { myRole: next || null });
      setRole(next || null);
      propRoleRef.current = next || null; // проп догонит позже — не откатывать показ
      setEditing(false);
      // Карточка живёт в ОБЩЕМ кэше окружения: без инвалидации новая роль не
      // доедет ни до грида, ни до пикеров других сервисов. Без await: сбой
      // ПЕРЕЗАПРОСА не должен показывать ошибку сохранения, которое прошло.
      void queryClient.invalidateQueries({ queryKey: contactsKey });
    } catch (err) {
      toastError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-2)' }}>
        {role ? (
          // Носитель действия — кнопка кита, а внутри неё бейдж роли: так у
          // «нажми, чтобы изменить» есть форма и фокус, а вид бейджа остаётся
          // скиновым (его рисуют токены скина, а не кит).
          <Button
            variant="ghost"
            size="sm"
            iconRight="edit"
            onClick={() => { setDraft(role); setEditing(true); }}
            aria-label={`Изменить роль (сейчас: ${role})`}
            title="Изменить роль"
            style={{ padding: '0.15rem 0.4rem', minHeight: 0 }}
          >
            <RoleBadge role={role} skin={skin} size="XL" />
          </Button>
        ) : (
          <Button variant="outline" size="sm" icon="edit" onClick={() => { setDraft(''); setEditing(true); }}>
            Указать роль
          </Button>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 'var(--spacing-3)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      <Input
        label={`Как я называю: ${ctx.personName}`}
        hint="Подпись видна только вам"
        value={draft}
        maxLength={ROLE_MAX_LENGTH}
        placeholder="Жена, Коллега, Друг…"
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save(draft); }
          if (e.key === 'Escape') {
            // Esc отменяет ПРАВКУ, а не закрывает карточку: ModalShell слушает
            // Esc на подложке, и одно нажатие уносило бы вместе с полем всё окно.
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', maxHeight: 116, overflowY: 'auto' }}>
        {ROLE_PRESETS.map((preset) => (
          <Chip key={preset} size="sm" tone="accent" selected={draft === preset} onClick={() => setDraft(preset)}>
            {preset}
          </Chip>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" tone="success" loading={saving} onClick={() => void save(draft)}>
          Сохранить
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>Отмена</Button>
        {role && (
          <Button size="sm" variant="matte" tone="danger" disabled={saving} onClick={() => void save(null)}>
            Убрать роль
          </Button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Staff card (B2B «Сотрудники») — ТА ЖЕ карта и то же поведение, что в гриде
// «Моё окружение» (L, клик → XL-оверлей, «Написать» под телом); отличаются
// только действия: вместо групп/блока — маленькая кнопка «Управлять» (manager+).
// Бейдж карты = Должность; данные = профиль человека, маскированный ЕГО
// «Видимостью в Компаниях» (бэкенд уже отдаёт скрытые поля как null).
// ============================================================

export interface StaffCardData {
  phone: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  dateOfBirth: string | null;
  bio: string | null;
  city: string | null;
  email: string | null;
  maritalStatus: string | null;
  socialLinks: { telegram?: string; instagram?: string } | null;
  age: number | null;
  showOnlineStatus: boolean;
}

export const StaffPersonCard = memo(function StaffPersonCard({
  userId, card, positions, branches, onWrite, onManage,
}: {
  userId: string;
  card: StaffCardData;
  /** Должности — бейдж карты (одна или несколько; роль организации тут НЕ показывается). */
  positions: string[];
  /** Филиалы — отдельные чипы под должностью (визуально отделены от должности). */
  branches: string[];
  onWrite?: () => void;
  onManage?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const skin = usePersonSkin(userId) || DEFAULT_SKIN;

  const seed = userId.charCodeAt(0) + userId.charCodeAt(userId.length - 1);
  const rotation = -0.5 - (seed % 4) * 0.7;

  const person: CardPerson = {
    firstName: card.firstName,
    lastName: card.lastName,
    phone: card.phone,
    avatarInitial: (card.firstName || '?').charAt(0).toUpperCase(),
    avatar: card.avatar,
    dateOfBirth: card.dateOfBirth,
    age: card.age,
    city: card.city,
    bio: card.bio,
    maritalStatus: card.maritalStatus,
    email: card.email,
    socialLinks: card.socialLinks,
    showOnlineStatus: card.showOnlineStatus,
    // Бейдж карты = Должность(и). Филиалы рендерятся ОТДЕЛЬНЫМИ чипами ниже.
    role: positions.length ? positions.join(' / ') : null,
    presenceLine: null,
  };
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <>
      <CardShell size="L" skin={skin} rotation={rotation} interactive onClick={() => setExpanded(true)}>
        <CardBody person={person} size="L" skin={skin} onOpen={() => setExpanded(true)} />

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)' }}>
          {/* Филиалы — отдельные метки, визуально отделены от должности-бейджа.
              Метка в системе это Chip: своя вёрстка тут повторяла его руками. */}
          {branches.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', justifyContent: 'center' }}>
              {branches.map((b) => (
                <Chip key={b} size="sm" icon="branch">{b}</Chip>
              ))}
            </div>
          )}

          {/* Кнопки — «Написать» + «Управлять», обе явные и обе из кита:
              у прежних не было ни фокус-кольца, ни общего ховера (он подделывался
              мутацией style на каждой кнопке). */}
          {(onWrite || onManage) && (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
              {onWrite && (
                <Button variant="outline" size="sm" icon="messenger" onClick={(e) => { stop(e); onWrite(); }}>
                  Написать
                </Button>
              )}
              {onManage && (
                <Button variant="primary" size="sm" icon="settings" onClick={(e) => { stop(e); onManage(); }}>
                  Управлять
                </Button>
              )}
            </div>
          )}
        </div>
      </CardShell>

      {expanded && (
        <ExpandedCard
          person={person}
          skin={skin}
          onClose={() => setExpanded(false)}
          onWrite={onWrite}
        />
      )}
    </>
  );
});

// ============================================================
// Full card (profile page) — size switcher + optional toggles
// ============================================================

function FullCard({ profile, onToggleVisibility, skin, initialSize }: FullProps) {
  const [size, setSize] = useState<CardSize>(initialSize || 'XL');
  const activeSkin = skin || DEFAULT_SKIN;
  const vis = profile.cardVisibility;
  const editable = !!onToggleVisibility;

  const person = profileToPerson(profile);
  const wide = size === 'XL' || size === 'L';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-4)' }}>
      <SizeSwitcher size={size} onChange={setSize} />
      <div style={{ width: wide ? '100%' : undefined, maxWidth: size === 'XL' ? 420 : size === 'L' ? 280 : undefined }}>
        <CardShell size={size} skin={activeSkin} rotation={-1}>
          <CardBody person={person} size={size} skin={activeSkin} />
        </CardShell>
      </div>

      {/* Условие проверяет САМ обработчик (а не производный флаг): так TypeScript
          сужает тип внутри блока, и семь `!` рядом с вызовами не нужны — раньше
          «здесь точно не null» держалось на честном слове. */}
      {onToggleVisibility && size === 'XL' && (
        <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {profile.city && <VisibilityRow label="Город" value={profile.city} visible={vis.city} onToggle={(v) => onToggleVisibility('city', v)} />}
          {profile.bio && <VisibilityRow label="О себе" value={profile.bio} visible={vis.bio} onToggle={(v) => onToggleVisibility('bio', v)} />}
          {profile.dateOfBirth && <VisibilityRow label="Дата рождения" value={formatDate(profile.dateOfBirth)} visible={vis.dateOfBirth} onToggle={(v) => onToggleVisibility('dateOfBirth', v)} />}
          {profile.dateOfBirth && <VisibilityRow label="Возраст" value={`${calcAge(profile.dateOfBirth)} лет`} visible={vis.age} onToggle={(v) => onToggleVisibility('age', v)} />}
          <VisibilityRow label="Онлайн-статус" value="Виден другим" visible={vis.onlineStatus} onToggle={(v) => onToggleVisibility('onlineStatus', v)} />
          {profile.maritalStatus && <VisibilityRow label="Семейное положение" value={MARITAL_LABELS[profile.maritalStatus] || profile.maritalStatus} visible={vis.maritalStatus} onToggle={(v) => onToggleVisibility('maritalStatus', v)} />}
          {profile.email && <VisibilityRow label="Email" value={profile.email} visible={vis.email} onToggle={(v) => onToggleVisibility('email', v)} />}
        </div>
      )}

      <div className="label-sm" style={{ textAlign: 'center', opacity: 0.5 }}>
        {editable ? 'Так тебя видят другие' : 'Так выглядит карточка для этой роли'}
      </div>
    </div>
  );
}

function SizeSwitcher({ size, onChange }: { size: CardSize; onChange: (s: CardSize) => void }) {
  // Взаимоисключающий выбор одного из пяти — это пилюля-переключатель кита:
  // стрелки, aria-pressed и фокус-кольцо из коробки. Пять самодельных кнопок
  // не давали ни того, ни другого, ни третьего.
  return (
    <SegmentedControl<CardSize>
      aria-label="Размер карточки"
      value={size}
      onChange={onChange}
      items={CARD_SIZES.map(({ key, label }) => ({ key, label }))}
    />
  );
}

// ============================================================
// Visibility toggle row (profile edit)
// ============================================================

function VisibilityRow({ label, value, visible, onToggle }: {
  label: string; value: string; visible: boolean; onToggle: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)',
      padding: 'var(--spacing-2) var(--spacing-3)', borderRadius: 'var(--radius-sm)',
      opacity: visible ? 1 : 0.3, transition: 'opacity 0.2s ease',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label-sm" style={{ fontSize: '0.7rem', marginBottom: '0.1rem' }}>{label}</div>
        <div style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--on-surface)' }}>{value}</div>
      </div>
      {/* Тумблер кита: role="switch", aria-checked, фокус-кольцо и зелёный ON по
          правилу системы. Своя копия была просто крашеным прямоугольником —
          скринридер видел безымянную кнопку без состояния. */}
      <Toggle
        checked={visible}
        onChange={onToggle}
        aria-label={`${label}: видно другим`}
        className="shrink-0"
      />
    </div>
  );
}

// ============================================================
// Normalizers + helpers
// ============================================================

// Присутствие сюда не приходит: размер L его не показывает, а XL запрашивает
// сам (см. useSinglePresence) — грид больше не тянет батч на сотню человек ради
// строки, которую видно только в развёрнутой карточке.
function contactToPerson(contact: Contact): CardPerson {
  const t = contact.them;
  return {
    firstName: t.firstName,
    lastName: t.lastName,
    phone: t.phone,
    avatarInitial: t.firstName.charAt(0).toUpperCase(),
    avatar: t.avatar,
    dateOfBirth: t.dateOfBirth,
    age: t.age,
    city: t.city,
    bio: t.bio,
    maritalStatus: t.maritalStatus,
    email: t.email,
    socialLinks: t.socialLinks,
    showOnlineStatus: t.showOnlineStatus,
    role: contact.myRole,
    presenceLine: null,
  };
}

// Profile preview: mask fields by the resolved visibility, so the card
// shows exactly what a viewer in the selected segment would see.
function profileToPerson(profile: ProfileData): CardPerson {
  const vis = profile.cardVisibility;
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    avatarInitial: profile.firstName.charAt(0).toUpperCase(),
    avatar: profile.avatar,
    dateOfBirth: vis.dateOfBirth ? profile.dateOfBirth : null,
    age: vis.age && profile.dateOfBirth ? calcAge(profile.dateOfBirth) : null,
    city: vis.city ? profile.city : null,
    bio: vis.bio ? profile.bio : null,
    maritalStatus: vis.maritalStatus ? profile.maritalStatus : null,
    email: vis.email ? profile.email : null,
    socialLinks: vis.socialLinks ? profile.socialLinks : null,
    showOnlineStatus: vis.onlineStatus,
    role: null,
    presenceLine: null,
  };
}

const MARITAL_LABELS: Record<string, string> = {
  single: 'Не женат/не замужем',
  married: 'Женат/замужем',
  relationship: 'В отношениях',
  divorced: 'Разведён(а)',
  widowed: 'Вдовец/вдова',
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function calcAge(iso: string): number {
  const birth = new Date(iso);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

function OnlineDot() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16"
      style={{ position: 'absolute', bottom: 4, right: 4, zIndex: 2, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.15))' }}
    >
      <path
        d="M8 2 C10 1.8, 13 3.5, 13.5 6 C14 8.5, 13 12, 10 13.5 C7.5 14.5, 3.5 13, 2.5 10 C1.5 7, 2.5 3, 5 2.2 C6.5 1.8, 7.5 2, 8 2Z"
        fill="var(--success)" stroke="var(--surface)" strokeWidth="1.5"
      />
    </svg>
  );
}
