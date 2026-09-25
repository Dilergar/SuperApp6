import * as os from 'node:os';

// ============================================================
// Адреса базы: пул приложения, прямой (миграции, обслуживание), обслуживающий
// ============================================================
// `DATABASE_URL` — пул приложения; в production это PgBouncer (режим транзакций, CVE-закрытая
// версия ≥ 1.26 — docs/data_architecture.md). Размер пула процесса задаётся ЯВНО: Prisma по
// умолчанию берёт `num_cpus * 2 + 1`, и N инстансов молча съедают `max_connections` базы.
// `DIRECT_URL` — мимо пулера: `prisma migrate`, онлайн-DDL, операции, которым нужна сессия
// (REINDEX CONCURRENTLY, долгие роллапы). Без него — тот же `DATABASE_URL` (разработка).

/** Соединений на процесс по умолчанию: 2 × ядра, в разумных пределах. */
function defaultPoolSize(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(50, Math.max(5, cores * 2));
}

function withParams(raw: string, params: Record<string, string>, overwrite = false): string {
  try {
    const u = new URL(raw);
    for (const [k, v] of Object.entries(params)) if (overwrite || !u.searchParams.has(k)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return raw; // адрес не URL (сокет, особый формат) — как есть: Prisma разберёт сам
  }
}

/** Пул приложения: `DATABASE_URL` + `connection_limit` (свой в адресе побеждает). */
export function appDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  const size = Number(process.env.DATABASE_POOL_SIZE) || defaultPoolSize();
  return withParams(raw, { connection_limit: String(size) });
}

/** Прямое подключение мимо пулера (миграции, онлайн-DDL). */
export function directDatabaseUrl(): string | undefined {
  return process.env.DIRECT_URL || process.env.DATABASE_URL || undefined;
}

/**
 * Обслуживающее подключение: прямое, два соединения, таймауты роли приложения сняты
 * параметрами запуска (они старше `ALTER ROLE … SET`): REINDEX CONCURRENTLY очереди, суточный
 * роллап аналитики — законно долгие операции, которые `statement_timeout 30s` /
 * `transaction_timeout 5min` роли оборвали бы. Параметр `options` пулер не пропускает —
 * поэтому только прямой адрес.
 */
export function maintenanceDatabaseUrl(): string | undefined {
  const raw = directDatabaseUrl();
  if (!raw) return undefined;
  return withParams(
    raw,
    {
      connection_limit: '2',
      options: '-c statement_timeout=0 -c idle_in_transaction_session_timeout=600000 -c transaction_timeout=0',
    },
    true,
  );
}
