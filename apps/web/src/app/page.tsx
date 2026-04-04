import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-5xl font-bold text-[var(--accent)] mb-4">
        SuperApp6
      </h1>
      <p className="text-xl text-[var(--text-secondary)] mb-12 text-center max-w-lg">
        Одно приложение, один аккаунт — задачи, календарь, окружение и рабочие инструменты
      </p>

      <div className="flex gap-4">
        <Link
          href="/login"
          className="px-8 py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-xl text-lg font-semibold transition-colors"
        >
          Войти
        </Link>
        <Link
          href="/register"
          className="px-8 py-3 border border-[var(--border)] hover:border-[var(--accent)] text-white rounded-xl text-lg font-semibold transition-colors"
        >
          Регистрация
        </Link>
      </div>

      {/* Features grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 max-w-4xl w-full">
        <FeatureCard
          title="Окружение"
          description="Организуйте контакты по ролям: семья, друзья, коллеги"
          icon="👥"
        />
        <FeatureCard
          title="Задачи"
          description="Ставьте задачи себе и близким с наградами и сроками"
          icon="✅"
        />
        <FeatureCard
          title="Календарь"
          description="Все события и задачи в одном месте с синхронизацией Google"
          icon="📅"
        />
      </div>
    </div>
  );
}

function FeatureCard({ title, description, icon }: { title: string; description: string; icon: string }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 text-center">
      <div className="text-4xl mb-4">{icon}</div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-[var(--text-secondary)] text-sm">{description}</p>
    </div>
  );
}
