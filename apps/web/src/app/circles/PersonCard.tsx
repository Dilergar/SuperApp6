'use client';

import { useState } from 'react';

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
}

interface Contact {
  linkId: string;
  relationshipType: string;
  them: ContactUserCard;
  myLabelForThem: string | null;
  theirLabelForMe: string | null;
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

// ============================================================
// Compact mode props (for circles grid)
// ============================================================

interface CompactProps {
  mode?: 'compact';
  contact: Contact;
  folders: Folder[];
  activeFolder: string | null;
  onDelete: () => void;
  onRemoveFromFolder: () => void;
  onAddToFolder: (folderId: string) => void;
}

// ============================================================
// Full mode props (for profile page)
// ============================================================

interface FullProps {
  mode: 'full';
  profile: ProfileData;
  onToggleVisibility: (field: keyof CardVisibility, value: boolean) => void;
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

// ============================================================
// Compact card (circles grid)
// ============================================================

function CompactCard({
  contact, folders, activeFolder, onDelete, onRemoveFromFolder, onAddToFolder,
}: CompactProps) {
  const [showFolderMenu, setShowFolderMenu] = useState(false);

  const foldersNotIn = folders.filter((f) => !contact.myCircleIds.includes(f.id));
  const foldersIn = folders.filter((f) => contact.myCircleIds.includes(f.id));

  const seed = contact.linkId.charCodeAt(0) + contact.linkId.charCodeAt(contact.linkId.length - 1);
  const rotation = -0.5 - (seed % 4) * 0.7;
  const initial = contact.them.firstName.charAt(0).toUpperCase();

  return (
    <div className="person-card-sketch" style={{ '--card-rotation': `${rotation}deg` } as React.CSSProperties}>
      {/* Action buttons */}
      <div style={{ position: 'absolute', top: 12, right: 14, display: 'flex', gap: '0.4rem', alignItems: 'center', zIndex: 3 }}>
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
        <button onClick={onDelete} style={{ background: 'none', border: 'none', color: 'var(--outline)', cursor: 'pointer', fontSize: '1rem', padding: '0.1rem', opacity: 0.25 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.7'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.25'; }}
          title="Удалить"
        >×</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-3)' }}>
        <div className="avatar-frame-outer">
          <div className="avatar-frame-inner">{initial}</div>
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.35rem', fontWeight: 700, letterSpacing: '0.05em', textAlign: 'center', color: 'var(--on-surface)', marginTop: 'var(--spacing-2)', textTransform: 'uppercase' }}>
          {contact.them.firstName} {contact.them.lastName || ''}
        </div>
        <div className="label-sm" style={{ textAlign: 'center', marginTop: '-0.3rem' }}>{contact.them.phone}</div>
        {contact.them.city && <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.7rem' }}>{contact.them.city}</div>}
        {contact.them.bio && <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.7rem', fontStyle: 'italic', maxWidth: '180px' }}>{contact.them.bio}</div>}
        {contact.them.dateOfBirth && <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.7rem' }}>{formatDate(contact.them.dateOfBirth)}</div>}
        {contact.them.maritalStatus && <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.7rem' }}>{MARITAL_LABELS[contact.them.maritalStatus] || contact.them.maritalStatus}</div>}
        {contact.them.email && <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.7rem' }}>{contact.them.email}</div>}
        {contact.them.socialLinks && (contact.them.socialLinks.telegram || contact.them.socialLinks.instagram) && (
          <div className="label-sm" style={{ textAlign: 'center', fontSize: '0.65rem' }}>
            {contact.them.socialLinks.telegram && `TG: ${contact.them.socialLinks.telegram}`}
            {contact.them.socialLinks.telegram && contact.them.socialLinks.instagram && ' · '}
            {contact.them.socialLinks.instagram && `IG: ${contact.them.socialLinks.instagram}`}
          </div>
        )}
        {contact.myLabelForThem && <div className="sketch-role-badge">{contact.myLabelForThem}</div>}
        {foldersIn.length > 0 && (
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'center', marginTop: 'var(--spacing-1)' }}>
            {foldersIn.map((f) => (
              <span key={f.id} style={{ fontSize: '0.65rem', padding: '0.1rem 0.5rem', borderRadius: '0.3rem', background: f.color || 'var(--surface-container-high)', opacity: 0.7, fontWeight: 500 }}>{f.name}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Shared constants
// ============================================================

const MARITAL_LABELS: Record<string, string> = {
  single: 'Не женат/не замужем',
  married: 'Женат/замужем',
  relationship: 'В отношениях',
  divorced: 'Разведён(а)',
  widowed: 'Вдовец/вдова',
};

// ============================================================
// Full card (profile page — with all fields + visibility toggles)
// ============================================================

function FullCard({ profile, onToggleVisibility }: FullProps) {
  const initial = profile.firstName.charAt(0).toUpperCase();
  const vis = profile.cardVisibility;

  return (
    <div className="person-card-sketch" style={{
      '--card-rotation': '-1deg',
      maxWidth: '420px',
      width: '100%',
      padding: 'var(--spacing-8)',
    } as React.CSSProperties}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--spacing-3)' }}>
        {/* Avatar — large */}
        <div className="avatar-frame-outer" style={{ padding: '6px' }}>
          <div className="avatar-frame-inner" style={{ width: '160px', height: '160px', fontSize: '4rem' }}>
            {initial}
          </div>
        </div>

        {/* Name — always visible */}
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: '1.6rem', fontWeight: 700,
          letterSpacing: '0.05em', textAlign: 'center', color: 'var(--on-surface)',
          marginTop: 'var(--spacing-2)', textTransform: 'uppercase',
        }}>
          {profile.firstName} {profile.lastName || ''}
        </div>

        {/* Phone — always visible */}
        <div className="label-md" style={{ textAlign: 'center' }}>{profile.phone}</div>

        {/* Toggleable fields */}
        <div style={{ width: '100%', marginTop: 'var(--spacing-4)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>

          {/* City */}
          {profile.city && (
            <VisibilityRow label="Город" value={profile.city} visible={vis.city}
              onToggle={(v) => onToggleVisibility('city', v)} />
          )}

          {/* Bio */}
          {profile.bio && (
            <VisibilityRow label="О себе" value={profile.bio} visible={vis.bio}
              onToggle={(v) => onToggleVisibility('bio', v)} />
          )}

          {/* Date of birth */}
          {profile.dateOfBirth && (
            <VisibilityRow label="Дата рождения" value={formatDate(profile.dateOfBirth)} visible={vis.dateOfBirth}
              onToggle={(v) => onToggleVisibility('dateOfBirth', v)} />
          )}

          {/* Marital status */}
          {profile.maritalStatus && (
            <VisibilityRow label="Семейное положение" value={MARITAL_LABELS[profile.maritalStatus] || profile.maritalStatus} visible={vis.maritalStatus}
              onToggle={(v) => onToggleVisibility('maritalStatus', v)} />
          )}

          {/* Email */}
          {profile.email && (
            <VisibilityRow label="Email" value={profile.email} visible={vis.email}
              onToggle={(v) => onToggleVisibility('email', v)} />
          )}

          {/* Social links */}
          {profile.socialLinks && (profile.socialLinks.telegram || profile.socialLinks.instagram) && (
            <VisibilityRow
              label="Соц. сети"
              value={[
                profile.socialLinks.telegram && `TG: ${profile.socialLinks.telegram}`,
                profile.socialLinks.instagram && `IG: ${profile.socialLinks.instagram}`,
              ].filter(Boolean).join(', ')}
              visible={vis.socialLinks}
              onToggle={(v) => onToggleVisibility('socialLinks', v)}
            />
          )}
        </div>

        {/* Empty state for optional fields */}
        {!profile.city && !profile.bio && !profile.dateOfBirth && !profile.email && (
          <p className="label-sm" style={{ textAlign: 'center', marginTop: 'var(--spacing-4)', opacity: 0.5 }}>
            Заполните профиль чтобы карточка стала информативнее
          </p>
        )}
      </div>

      {/* Label */}
      <div className="label-sm" style={{ textAlign: 'center', marginTop: 'var(--spacing-6)', opacity: 0.5 }}>
        Так тебя видят другие
      </div>
    </div>
  );
}

// ============================================================
// Visibility toggle row
// ============================================================

function VisibilityRow({ label, value, visible, onToggle }: {
  label: string; value: string; visible: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)',
      padding: 'var(--spacing-2) var(--spacing-3)',
      borderRadius: 'var(--radius-sm)',
      opacity: visible ? 1 : 0.3,
      transition: 'opacity 0.2s ease',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label-sm" style={{ fontSize: '0.7rem', marginBottom: '0.1rem' }}>{label}</div>
        <div style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--on-surface)' }}>{value}</div>
      </div>
      <button
        onClick={() => onToggle(!visible)}
        style={{
          width: '2.5rem', height: '1.3rem', borderRadius: '0.65rem',
          border: 'none', cursor: 'pointer', position: 'relative',
          background: visible ? 'var(--secondary)' : 'var(--outline-variant)',
          transition: 'background 0.2s ease',
          flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: '2px',
          left: visible ? '1.3rem' : '2px',
          width: '1rem', height: '1rem', borderRadius: '50%',
          background: 'var(--surface-container-lowest)',
          transition: 'left 0.2s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }} />
      </button>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
