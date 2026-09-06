import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

// ============================================================
// Публичная витрина. СЕРВЕРНЫЙ компонент — подписи берутся через
// `getTranslations`, поэтому каталог `landing` не уезжает в браузер вовсе
// (клиентского состояния на странице нет), а первый кадр приходит уже на
// нужном языке.
//
// Это первый экран человека, который ещё ничего не выбирал: язык решает
// `Accept-Language` его браузера (незнакомый → казахский, см. docs/i18n.md).
// ============================================================

export default async function HomePage() {
  const t = await getTranslations('landing');

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav — glassmorphism */}
      <nav className="fixed top-0 w-full z-50 px-6 py-4" style={{
        background: 'color-mix(in srgb, var(--page) 70%, transparent)',
        backdropFilter: 'blur(10px)',
      }}>
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <span className="title-md" style={{ color: 'var(--primary)' }}>SuperApp6</span>
          <div className="flex gap-3 items-center">
            {/*
              Переключатель ЗДЕСЬ, а не только на /login: витрина — первый экран
              человека, которому язык угадал браузер. Если угадали неверно, он не
              должен искать, где это исправить.
            */}
            <LanguageSwitcher compact width={150} />
            <Link href="/login" className="btn-secondary" style={{ padding: '0.5rem 1.5rem', fontSize: '0.875rem' }}>
              {t('nav.signIn')}
            </Link>
            <Link href="/register" className="btn-primary" style={{ padding: '0.5rem 1.5rem', fontSize: '0.875rem' }}>
              {t('nav.start')}
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
                {t('hero.line1')}
                <br />
                <span style={{ color: 'var(--primary)' }}>{t('hero.line2')}</span>
              </h1>
              <p style={{
                fontSize: '1.125rem',
                lineHeight: '1.7',
                color: 'var(--on-surface-variant)',
                marginBottom: 'var(--spacing-10)',
                maxWidth: '24rem',
              }}>
                {t('hero.text')}
              </p>
              <div className="flex gap-4 items-center">
                <Link href="/register" className="btn-success" style={{ fontSize: '1.1rem', padding: '0.875rem 2.5rem' }}>
                  {t('hero.cta')}
                </Link>
                <span className="label-sm">{t('hero.trial')}</span>
              </div>
            </div>

            {/* Right — stacked cards, asymmetric */}
            <div className="relative" style={{ minHeight: '360px' }}>
              {/* Background wash */}
              <div className="alert-neutral-inline absolute" style={{
                width: '80%',
                height: '70%',
                top: '15%',
                left: '10%',
              }} />

              {/* Card 1 — top */}
              <div className="card-elevated absolute" style={{
                top: '0',
                left: '5%',
                width: '75%',
              }}>
                <div className="label-sm" style={{ marginBottom: 'var(--spacing-2)' }}>{t('demo.circleLabel')}</div>
                <div className="title-md">{t('demo.circleName')}</div>
                <div style={{ marginTop: 'var(--spacing-3)', display: 'flex', gap: 'var(--spacing-2)' }}>
                  <span className="alert-accent-inline" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>{t('demo.wife')}</span>
                  <span className="alert-accent-inline" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>{t('demo.mom')}</span>
                  <span className="alert-accent-inline" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}>{t('demo.brother')}</span>
                </div>
              </div>

              {/* Card 2 — bottom right, overlapping */}
              <div className="card-elevated absolute" style={{
                bottom: '0',
                right: '0',
                width: '70%',
              }}>
                <div className="label-sm" style={{ marginBottom: 'var(--spacing-2)' }}>{t('demo.taskLabel')}</div>
                <div className="title-md">{t('demo.taskTitle')}</div>
                <div style={{
                  marginTop: 'var(--spacing-3)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                  <span className="label-sm">{t('demo.taskDue')}</span>
                  <span style={{
                    background: 'var(--tertiary-container)',
                    padding: '0.2rem 0.6rem',
                    borderRadius: 'var(--radius-sketch)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}>{t('demo.taskCoins')}</span>
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
            {t('features.titleBefore')}<span style={{ color: 'var(--primary)' }}>{t('features.titleAccent')}</span>{t('features.titleAfter')}
          </h2>

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              title={t('features.circle.title')}
              description={t('features.circle.text')}
              accent="var(--primary-container)"
              offset="mt-0"
            />
            <FeatureCard
              title={t('features.tasks.title')}
              description={t('features.tasks.text')}
              accent="var(--secondary-container)"
              offset="mt-6"
            />
            <FeatureCard
              title={t('features.calendar.title')}
              description={t('features.calendar.text')}
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
            {t('cta.title')}
          </h2>
          <p className="label-md" style={{ marginBottom: 'var(--spacing-8)', fontSize: '1rem' }}>
            {t('cta.text')}
          </p>
          <Link href="/register" className="btn-primary" style={{ fontSize: '1.1rem', padding: '0.875rem 2.5rem' }}>
            {t('cta.button')}
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
