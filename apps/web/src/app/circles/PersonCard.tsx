'use client';

import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';

// lottie-web (~70KB gz) is loaded ON DEMAND, only when a card with a Lottie effect
// actually renders — a static import shipped it in EVERY route's bundle because
// PersonCard/PersonChip are imported by calendar/messenger/tasks/shop.
const Lottie = dynamic(() => import('lottie-react'), { ssr: false });
import type { PresenceInfo } from '@superapp/shared';
import { presenceStatusLine } from '../messenger/presence-ui';
import type { CardSize, CardSkinRender } from './card-skin';
import {
  DEFAULT_SKIN,
  SIZE_CONFIG,
  RARITY_META,
  CARD_SIZES,
  displayName,
} from './card-skin';
import { usePersonSkin } from '@/lib/person-skins';

// ============================================================
// Types
// ============================================================

interface ContactUserCard {
  id: string;
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

interface Contact {
  linkId: string;
  them: ContactUserCard;
  myRole: string | null;
  theirRole: string | null;
  confirmedAt: string;
  myCircleIds: string[];
}

interface Folder {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  membersCount: number;
}

interface CardVisibility {
  dateOfBirth: boolean;
  age: boolean;
  onlineStatus: boolean;
  maritalStatus: boolean;
  city: boolean;
  bio: boolean;
  email: boolean;
  socialLinks: boolean;
}

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
  folders: Folder[];
  activeFolder: string | null;
  onDelete: () => void;
  /** Block this person (confirm + API live in the page handler). */
  onBlock?: () => void;
  onRemoveFromFolder: () => void;
  onAddToFolder: (folderId: string) => void;
  /** Balance of MY currency this person holds (visible to me as the issuer). */
  myCoins?: { icon: string; balance: number } | null;
  /** Live presence (online / lastSeen / contextual), already tailored to me. */
  presence?: PresenceInfo | null;
  /** Skin worn for me by this person (Phase 2). Defaults to the free skin. */
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

export function PersonCard(props: PersonCardProps) {
  const mode = props.mode || 'compact';
  if (mode === 'full') return <FullCard {...(props as FullProps)} />;
  return <CompactCard {...(props as CompactProps)} />;
}

/**
 * Plain, sized person card (no grid chrome) — reusable wherever a person is shown
 * inline: task pickers (M), mention rows (S), tight spots (XS). Resolves the skin itself.
 */
export function PersonChip({
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
}

// ============================================================
// Card shell — skin-driven container + decoration layers
// ============================================================

function CardShell({
  size, skin, rotation, onClick, interactive, children, style,
}: {
  size: CardSize;
  skin: CardSkinRender;
  rotation: number;
  onClick?: () => void;
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
      {skin.decor === 'crayon' && <CrayonDecor />}
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

// Crayon strokes — the built-in sketchbook decoration (was a CSS ::before).
function CrayonDecor() {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: 'inherit', zIndex: 0,
        background:
          'linear-gradient(92deg, rgba(198,26,30,0.55) 0%, rgba(198,26,30,0.1) 100%) no-repeat 12px calc(100% - 14px) / 38px 5px,' +
          'linear-gradient(85deg, rgba(198,26,30,0.35) 0%, rgba(198,26,30,0.05) 100%) no-repeat 18px calc(100% - 22px) / 30px 4px,' +
          'linear-gradient(88deg, rgba(50,106,139,0.5) 0%, rgba(50,106,139,0.08) 100%) no-repeat calc(100% - 16px) calc(100% - 16px) / 34px 4px,' +
          'linear-gradient(95deg, rgba(50,106,139,0.3) 0%, rgba(50,106,139,0.05) 100%) no-repeat calc(100% - 20px) calc(100% - 24px) / 28px 5px',
      }}
    />
  );
}

// ============================================================
// Card body — avatar + name + fields, sized + skinned
// ============================================================

function CardBody({ person, size, skin }: { person: CardPerson; size: CardSize; skin: CardSkinRender }) {
  const cfg = SIZE_CONFIG[size];
  const t = skin.tokens;
  const showDot = cfg.showPresence && person.showOnlineStatus;

  const nameEl = cfg.showName ? (
    <div style={{
      fontFamily: t.nameFont, fontSize: cfg.nameSize, fontWeight: 700,
      letterSpacing: '0.04em', color: t.nameColor,
      textTransform: size === 'XS' ? 'none' : 'uppercase',
      textAlign: cfg.layout === 'row' ? 'left' : 'center', lineHeight: 1.1,
      ...(cfg.layout === 'row' ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '12rem' } : {}),
    }}>
      {displayName(person.firstName, person.lastName, cfg.fullLastName)}
    </div>
  ) : null;

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
      fontSize: Math.round(size * 0.4), boxShadow: 'inset 0 2px 8px rgba(56,57,45,0.06)',
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
  return (
    <div style={{
      display: 'inline-block', padding: small ? '0.12rem 0.55rem' : '0.3rem 1.2rem',
      background: t.badgeBg, color: t.badgeColor, borderRadius: '0.6rem 0.9rem 0.7rem 0.8rem',
      fontFamily: 'var(--font-display)', fontSize: small ? '0.62rem' : '0.85rem', fontWeight: 600,
      letterSpacing: '0.03em', boxShadow: t.badgeShadow,
    }}>
      {role}
    </div>
  );
}

function RarityChip({ rarity }: { rarity: CardSkinRender['rarity'] }) {
  const m = RARITY_META[rarity];
  return (
    <div style={{
      display: 'inline-block', padding: '0.1rem 0.6rem', fontSize: '0.62rem', fontWeight: 700,
      fontFamily: 'var(--font-display)', letterSpacing: '0.08em', textTransform: 'uppercase',
      color: m.color, borderRadius: '0.5rem 0.7rem 0.55rem 0.65rem',
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
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();

  const activeSkin = skin || DEFAULT_SKIN;
  const presenceLine = presenceStatusLine(presence);
  const foldersNotIn = folders.filter((f) => !contact.myCircleIds.includes(f.id));
  const foldersIn = folders.filter((f) => contact.myCircleIds.includes(f.id));

  const seed = contact.linkId.charCodeAt(0) + contact.linkId.charCodeAt(contact.linkId.length - 1);
  const rotation = -0.5 - (seed % 4) * 0.7;

  const person = contactToPerson(contact, presenceLine);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <>
      <CardShell size="L" skin={activeSkin} rotation={rotation} interactive onClick={() => setExpanded(true)}>
        {/* Action buttons */}
        <div onClick={stop} style={{ position: 'absolute', top: 12, right: 14, display: 'flex', gap: '0.4rem', alignItems: 'center', zIndex: 3 }}>
          {activeFolder ? (
            <button onClick={onRemoveFromFolder} title="Убрать из папки"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.65rem', color: 'var(--on-surface-variant)', opacity: 0.4 }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4'; }}
            >убрать</button>
          ) : (
            <div style={{ position: 'relative' }}>
              {folders.length > 0 && (
                <button onClick={() => setShowFolderMenu(!showFolderMenu)} title="Добавить в папку"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--outline)', opacity: 0.3, padding: '0.1rem' }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                  onMouseLeave={(e) => { if (!showFolderMenu) e.currentTarget.style.opacity = '0.3'; }}
                >+</button>
              )}
              {showFolderMenu && foldersNotIn.length > 0 && (
                <div style={{ position: 'absolute', right: 0, top: '100%', zIndex: 10, background: 'var(--surface-container-lowest)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 32px rgba(56, 57, 45, 0.15)', padding: 'var(--spacing-2)', minWidth: '120px' }}>
                  {foldersNotIn.map((f) => (
                    <button key={f.id} onClick={() => { onAddToFolder(f.id); setShowFolderMenu(false); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', padding: '0.3rem 0.5rem', width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', color: 'var(--on-surface)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-container-low)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                    >
                      <span style={{ width: '0.6rem', height: '0.6rem', borderRadius: '0.2rem', background: f.color || 'var(--surface-container-high)' }} />
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {onBlock && (
            <button onClick={onBlock} style={{ background: 'none', border: 'none', color: 'var(--outline)', cursor: 'pointer', fontSize: '0.62rem', fontWeight: 600, padding: '0.1rem', opacity: 0.25 }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.color = 'var(--primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.25'; e.currentTarget.style.color = 'var(--outline)'; }}
              title="Заблокировать"
            >блок</button>
          )}
          <button onClick={onDelete} style={{ background: 'none', border: 'none', color: 'var(--outline)', cursor: 'pointer', fontSize: '1rem', padding: '0.1rem', opacity: 0.25 }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.25'; }}
            title="Удалить"
          >×</button>
        </div>

        <CardBody person={person} size="L" skin={activeSkin} />

        {/* Grid extras — write / coins / folders */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)' }}>
          <button
            onClick={(e) => { stop(e); router.push(`/messenger?dm=${contact.them.id}`); }}
            style={{
              padding: '0.3rem 1.1rem', fontSize: '0.78rem', fontFamily: 'var(--font-display)', fontWeight: 600,
              color: 'var(--secondary)', background: 'transparent', border: '2px solid var(--secondary)',
              borderRadius: 'var(--radius-sketch)', cursor: 'pointer', transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--secondary-container)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Написать
          </button>
          {myCoins && myCoins.balance !== 0 && (
            <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.72rem', fontWeight: 600, color: 'var(--primary)' }}>
              держит {myCoins.balance.toLocaleString('ru-RU')} {myCoins.icon}
            </div>
          )}
          {foldersIn.length > 0 && (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
              {foldersIn.map((f) => (
                <span key={f.id} style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem', borderRadius: '0.3rem', background: f.color || 'var(--surface-container-high)', opacity: 0.7, fontWeight: 500 }}>{f.name}</span>
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
          onWrite={() => router.push(`/messenger?dm=${contact.them.id}`)}
        />
      )}
    </>
  );
}

// Expanded XL overlay shown when a grid card is clicked.
function ExpandedCard({ person, skin, onClose, onWrite }: {
  person: CardPerson; skin: CardSkinRender; onClose: () => void; onWrite?: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 'var(--spacing-6)',
        background: 'rgba(56,57,45,0.35)', backdropFilter: 'blur(4px)',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', maxWidth: 420, width: '100%' }}>
        <button
          onClick={onClose}
          title="Закрыть"
          style={{
            position: 'absolute', top: -10, right: -10, zIndex: 5, width: '2rem', height: '2rem',
            borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: '1.1rem',
            background: 'var(--surface-container-lowest)', color: 'var(--on-surface)',
            boxShadow: '0 4px 16px rgba(56,57,45,0.2)',
          }}
        >×</button>
        <CardShell size="XL" skin={skin} rotation={-1}>
          <CardBody person={person} size="XL" skin={skin} />
          {onWrite && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
              <button
                onClick={onWrite}
                style={{
                  padding: '0.4rem 1.4rem', fontSize: '0.85rem', fontFamily: 'var(--font-display)', fontWeight: 600,
                  color: 'var(--secondary)', background: 'transparent', border: '2px solid var(--secondary)',
                  borderRadius: 'var(--radius-sketch)', cursor: 'pointer',
                }}
              >
                Написать
              </button>
            </div>
          )}
        </CardShell>
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

export function StaffPersonCard({
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
        <CardBody person={person} size="L" skin={skin} />

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)' }}>
          {/* Филиалы — отдельные чипы (📍), визуально отделены от должности-бейджа */}
          {branches.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', justifyContent: 'center' }}>
              {branches.map((b) => (
                <span
                  key={b}
                  style={{
                    fontSize: '0.68rem', fontWeight: 600, padding: '0.12rem 0.5rem',
                    borderRadius: 'var(--radius-sketch)', background: 'var(--tertiary-container, var(--surface-container-high))',
                    color: 'var(--on-surface-variant)',
                  }}
                >
                  📍 {b}
                </span>
              ))}
            </div>
          )}

          {/* Кнопки — «Написать» + «Управлять», обе явные */}
          {(onWrite || onManage) && (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
              {onWrite && (
                <button
                  onClick={(e) => { stop(e); onWrite(); }}
                  style={{
                    padding: '0.3rem 1rem', fontSize: '0.76rem', fontFamily: 'var(--font-display)', fontWeight: 600,
                    color: 'var(--secondary)', background: 'transparent', border: '2px solid var(--secondary)',
                    borderRadius: 'var(--radius-sketch)', cursor: 'pointer', transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--secondary-container)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  Написать
                </button>
              )}
              {onManage && (
                <button
                  onClick={(e) => { stop(e); onManage(); }}
                  style={{
                    padding: '0.3rem 1rem', fontSize: '0.76rem', fontFamily: 'var(--font-display)', fontWeight: 600,
                    color: 'var(--on-primary, #fff)', background: 'var(--primary)', border: '2px solid var(--primary)',
                    borderRadius: 'var(--radius-sketch)', cursor: 'pointer', transition: 'opacity 0.15s ease',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
                >
                  Управлять
                </button>
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
}

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

      {editable && size === 'XL' && (
        <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
          {profile.city && <VisibilityRow label="Город" value={profile.city} visible={vis.city} onToggle={(v) => onToggleVisibility!('city', v)} />}
          {profile.bio && <VisibilityRow label="О себе" value={profile.bio} visible={vis.bio} onToggle={(v) => onToggleVisibility!('bio', v)} />}
          {profile.dateOfBirth && <VisibilityRow label="Дата рождения" value={formatDate(profile.dateOfBirth)} visible={vis.dateOfBirth} onToggle={(v) => onToggleVisibility!('dateOfBirth', v)} />}
          {profile.dateOfBirth && <VisibilityRow label="Возраст" value={`${calcAge(profile.dateOfBirth)} лет`} visible={vis.age} onToggle={(v) => onToggleVisibility!('age', v)} />}
          <VisibilityRow label="Онлайн-статус" value="Виден другим" visible={vis.onlineStatus} onToggle={(v) => onToggleVisibility!('onlineStatus', v)} />
          {profile.maritalStatus && <VisibilityRow label="Семейное положение" value={MARITAL_LABELS[profile.maritalStatus] || profile.maritalStatus} visible={vis.maritalStatus} onToggle={(v) => onToggleVisibility!('maritalStatus', v)} />}
          {profile.email && <VisibilityRow label="Email" value={profile.email} visible={vis.email} onToggle={(v) => onToggleVisibility!('email', v)} />}
        </div>
      )}

      <div className="label-sm" style={{ textAlign: 'center', opacity: 0.5 }}>
        {editable ? 'Так тебя видят другие' : 'Так выглядит карточка для этой роли'}
      </div>
    </div>
  );
}

function SizeSwitcher({ size, onChange }: { size: CardSize; onChange: (s: CardSize) => void }) {
  return (
    <div style={{ display: 'inline-flex', gap: '0.3rem', padding: '0.25rem', background: 'var(--surface-container-low)', borderRadius: 'var(--radius-md)' }}>
      {CARD_SIZES.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          style={{
            padding: '0.25rem 0.7rem', fontSize: '0.75rem', fontWeight: 700, fontFamily: 'var(--font-display)',
            cursor: 'pointer', border: 'none', borderRadius: 'var(--radius-sm)',
            background: size === key ? 'var(--secondary)' : 'transparent',
            color: size === key ? 'var(--on-secondary)' : 'var(--on-surface-variant)',
            transition: 'background 0.15s ease',
          }}
        >
          {label}
        </button>
      ))}
    </div>
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
      <button
        onClick={() => onToggle(!visible)}
        style={{
          width: '2.5rem', height: '1.3rem', borderRadius: '0.65rem', border: 'none', cursor: 'pointer',
          position: 'relative', background: visible ? 'var(--secondary)' : 'var(--outline-variant)',
          transition: 'background 0.2s ease', flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: '2px', left: visible ? '1.3rem' : '2px', width: '1rem', height: '1rem',
          borderRadius: '50%', background: 'var(--surface-container-lowest)', transition: 'left 0.2s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }} />
      </button>
    </div>
  );
}

// ============================================================
// Normalizers + helpers
// ============================================================

function contactToPerson(contact: Contact, presenceLine: string | null): CardPerson {
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
    presenceLine,
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
