'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';

interface UserProfile {
  id: string;
  phone: string;
  firstName: string;
  lastName: string | null;
  roles: Array<{ role: string; context: string; tenantId: string | null }>;
  activeSubscription: { plan: string; status: string; expiresAt: string } | null;
  circlesCount: number;
  workspacesCount: number;
}

const services = [
  { title: 'Окружение', description: 'Контакты с ролями', color: 'var(--primary-container)', href: '/circles' },
  { title: 'Задачи', description: 'Личные и назначенные', color: 'var(--secondary-container)', href: '/tasks' },
  { title: 'Календарь', description: 'События и расписание', color: 'var(--tertiary-container)', href: '/calendar' },
];

export default function DashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) { router.push('/login'); return; }

    api.get('/users/me')
      .then(({ data }) => setProfile(data.data))
      .catch(() => router.push('/login'))
      .finally(() => setLoading(false));
  }, [router]);

  const handleLogout = async () => {
    try {
      const refreshToken = localStorage.getItem('refreshToken');
      await api.post('/auth/logout', { refreshToken });
    } finally {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      router.push('/login');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>
      </div>
    );
  }

  if (!profile) return null;

  const greeting = () => {
    const hour = new Date().getHours();
    if (hour < 6) return 'Доброй ночи';
    if (hour < 12) return 'Доброе утро';
    if (hour < 18) return 'Добрый день';
    return 'Добрый вечер';
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      {/* Nav — glassmorphism */}
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{
        background: 'rgba(245, 245, 220, 0.7)',
        backdropFilter: 'blur(10px)',
      }}>
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="title-md" style={{ color: 'var(--primary)' }}>SuperApp6</span>
          <button
            onClick={handleLogout}
            className="btn-secondary"
            style={{ padding: '0.4rem 1.2rem', fontSize: '0.8rem' }}
          >
            Выйти
          </button>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        {/* Greeting — asymmetric */}
        <div style={{ paddingLeft: 'var(--spacing-2)', marginBottom: 'var(--spacing-12)' }}>
          <h1 className="display-md" style={{ marginBottom: 'var(--spacing-2)' }}>
            {greeting()},
            <br />
            <span style={{ color: 'var(--primary)' }}>{profile.firstName}</span>
          </h1>
          <p className="label-md" style={{ fontSize: '0.95rem' }}>{profile.phone}</p>
        </div>

        {/* Subscription — wash card */}
        {profile.activeSubscription && (
          <div className="wash-secondary" style={{
            padding: 'var(--spacing-6)',
            marginBottom: 'var(--spacing-10)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <div>
              <div className="label-sm" style={{ marginBottom: 'var(--spacing-1)' }}>Подписка</div>
              <span className="title-md" style={{ textTransform: 'capitalize' }}>
                {profile.activeSubscription.plan}
              </span>
            </div>
            <span style={{
              background: 'var(--surface-container-lowest)',
              padding: '0.35rem 1rem',
              borderRadius: 'var(--radius-sketch)',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'var(--secondary)',
            }}>
              {profile.activeSubscription.status === 'trial' ? 'Пробный период' : profile.activeSubscription.status}
            </span>
          </div>
        )}

        {/* Services — staggered grid */}
        <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)', paddingLeft: 'var(--spacing-2)' }}>
          Сервисы
        </h2>
        <div className="grid md:grid-cols-3" style={{ gap: 'var(--spacing-6)', marginBottom: 'var(--spacing-12)' }}>
          {services.map((s, i) => (
            <a
              key={s.title}
              href={s.href}
              className="card-elevated"
              style={{
                transform: `rotate(${i === 0 ? '-0.5' : i === 2 ? '0.5' : '0'}deg)`,
                transition: 'transform 0.2s ease, box-shadow 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'rotate(0deg) translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 12px 40px rgba(198, 26, 30, 0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = `rotate(${i === 0 ? '-0.5' : i === 2 ? '0.5' : '0'}deg)`;
                e.currentTarget.style.boxShadow = '0 8px 32px rgba(198, 26, 30, 0.06)';
              }}
            >
              <div style={{
                width: '2.5rem',
                height: '2.5rem',
                background: s.color,
                borderRadius: 'var(--radius-sketch)',
                marginBottom: 'var(--spacing-4)',
                opacity: 0.7,
              }} />
              <div className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>{s.title}</div>
              <p className="label-md">{s.description}</p>
            </a>
          ))}
        </div>

        {/* Roles */}
        {profile.roles.length > 0 && (
          <div style={{ paddingLeft: 'var(--spacing-2)' }}>
            <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-4)' }}>Мои роли</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-3)' }}>
              {profile.roles.map((r, i) => (
                <span
                  key={i}
                  className="ghost-border"
                  style={{
                    padding: '0.35rem 1rem',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    color: 'var(--on-surface-variant)',
                  }}
                >
                  {r.role}
                  <span style={{ opacity: 0.5, marginLeft: '0.3rem' }}>/ {r.context}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4" style={{
          gap: 'var(--spacing-6)',
          marginTop: 'var(--spacing-12)',
        }}>
          <StatCard label="Окружений" value={profile.circlesCount} />
          <StatCard label="Пространств" value={profile.workspacesCount} />
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div className="display-md" style={{ color: 'var(--primary)', fontSize: '2rem' }}>{value}</div>
      <div className="label-md" style={{ marginTop: 'var(--spacing-1)' }}>{label}</div>
    </div>
  );
}
