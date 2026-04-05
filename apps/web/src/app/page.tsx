import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav — glassmorphism */}
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{
        background: 'rgba(245, 245, 220, 0.7)',
        backdropFilter: 'blur(10px)',
      }}>
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <span className="title-md" style={{ color: 'var(--primary)' }}>SuperApp6</span>
          <div className="flex gap-3">
            <Link href="/login" className="btn-secondary" style={{ padding: '0.5rem 1.5rem', fontSize: '0.875rem' }}>
              Войти
            </Link>
            <Link href="/register" className="btn-primary" style={{ padding: '0.5rem 1.5rem', fontSize: '0.875rem' }}>
              Начать
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero — asymmetric layout */}
      <section className="flex-1 flex items-center pt-24" style={{ paddingBottom: 'var(--spacing-16)' }}>
        <div className="max-w-5xl mx-auto px-6 w-full">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            {/* Left — text, offset */}
            <div style={{ paddingLeft: 'var(--spacing-4)', paddingRight: 'var(--spacing-10)' }}>
              <h1 className="display-lg" style={{ color: 'var(--on-surface)', marginBottom: 'var(--spacing-6)' }}>
                Одно приложение.
                <br />
                <span style={{ color: 'var(--primary)' }}>Вся жизнь.</span>
              </h1>
              <p style={{
                fontSize: '1.125rem',
                lineHeight: '1.7',
                color: 'var(--on-surface-variant)',
                marginBottom: 'var(--spacing-10)',
                maxWidth: '24rem',
              }}>
                Задачи, календарь, окружение, рабочие инструменты — всё в одном аккаунте.
                Как скетчбук, в котором собрана вся ваша жизнь.
              </p>
              <div className="flex gap-4 items-center">
                <Link href="/register" className="btn-primary" style={{ fontSize: '1.1rem', padding: '0.875rem 2.5rem' }}>
                  Создать аккаунт
                </Link>
                <span className="label-sm">Бесплатно 3 месяца</span>
              </div>
            </div>

            {/* Right — stacked cards, asymmetric */}
            <div className="relative" style={{ minHeight: '360px' }}>
              {/* Background wash */}
              <div className="wash-primary absolute" style={{
                width: '80%',
                height: '70%',
                top: '15%',
                left: '10%',
                transform: 'rotate(-2deg)',
              }} />

              {/* Card 1 — top */}
              <div className="card-elevated absolute" style={{
                top: '0',
                left: '5%',
                width: '75%',
                transform: 'rotate(-1.5deg)',
              }}>
                <div className="label-sm" style={{ marginBottom: 'var(--spacing-2)' }}>Окружение</div>
                <div className="title-md">Семья</div>
                <div style={{ marginTop: 'var(--spacing-3)', display: 'flex', gap: 'var(--spacing-2)' }}>
                  <span className="wash-secondary" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>жена</span>
                  <span className="wash-secondary" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>мама</span>
                  <span className="wash-secondary" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>брат</span>
                </div>
              </div>

              {/* Card 2 — bottom right, overlapping */}
              <div className="card-elevated absolute" style={{
                bottom: '0',
                right: '0',
                width: '70%',
                transform: 'rotate(1deg)',
              }}>
                <div className="label-sm" style={{ marginBottom: 'var(--spacing-2)' }}>Задача</div>
                <div className="title-md">Купить продукты</div>
                <div style={{
                  marginTop: 'var(--spacing-3)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                  <span className="label-sm">до 18:00</span>
                  <span style={{
                    background: 'var(--tertiary-container)',
                    padding: '0.2rem 0.6rem',
                    borderRadius: 'var(--radius-sketch)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}>+5 коинов</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features — staggered cards */}
      <section style={{
        background: 'var(--surface-container-low)',
        padding: 'var(--spacing-16) 0',
      }}>
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="display-md text-center" style={{ marginBottom: 'var(--spacing-12)' }}>
            Ваш <span style={{ color: 'var(--primary)' }}>личный</span> суперапп
          </h2>

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              title="Окружение"
              description="Организуйте контакты по ролям: семья, друзья, коллеги. Назначайте задачи и делитесь календарём."
              accent="var(--primary-container)"
              offset="mt-0"
            />
            <FeatureCard
              title="Задачи"
              description="Ставьте задачи себе и близким. Подзадачи, сроки, приоритеты, коины за выполнение."
              accent="var(--secondary-container)"
              offset="mt-6"
            />
            <FeatureCard
              title="Календарь"
              description="Все события и задачи в одном месте. Синхронизация с Google Calendar, шаринг с семьёй."
              accent="var(--tertiary-container)"
              offset="mt-2"
            />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: 'var(--spacing-16) 0' }}>
        <div className="max-w-2xl mx-auto px-6 text-center">
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-6)' }}>
            Один аккаунт — для всего
          </h2>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', fontSize: '1rem' }}>
            Муж, друг, сотрудник, администратор — все роли в одном месте.
            Без лишних аккаунтов и паролей.
          </p>
          <Link href="/register" className="btn-primary" style={{ fontSize: '1.1rem', padding: '0.875rem 2.5rem' }}>
            Попробовать бесплатно
          </Link>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ title, description, accent, offset }: {
  title: string;
  description: string;
  accent: string;
  offset: string;
}) {
  return (
    <div className={`card-elevated ${offset}`}>
      <div style={{
        width: '3rem',
        height: '3rem',
        background: accent,
        borderRadius: 'var(--radius-sketch)',
        marginBottom: 'var(--spacing-4)',
        opacity: 0.7,
      }} />
      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{title}</h3>
      <p style={{ color: 'var(--on-surface-variant)', lineHeight: 1.6, fontSize: '0.95rem' }}>
        {description}
      </p>
    </div>
  );
}
