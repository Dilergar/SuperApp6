/* eslint-disable */
// Хвосты организаций, которых УЖЕ НЕТ: пространства Диска и заметок, офисные документы,
// файлы, ссылки наружу и их гости (имя + номер — ПДн), незакрытые заявки подписи и
// согласования. Остались от удалений до того, как каскад purgeWorkspace научился чистить
// движки, и от сырого удаления строк организаций (gc-test-workspaces.cjs).
//
//   node scripts/gc-orphan-workspace-data.cjs           — сухой прогон (что и сколько)
//   node scripts/gc-orphan-workspace-data.cjs --apply   — удалить
//
// Чистит ШТАТНЫМ путём — первой фазой каскада на сервере (`POST /workspaces/dev/purge-orphans`),
// а не своей копией в скрипте: личный архив КЭДО и доказательства подписи каскад пропускает
// сам. Живые и архивные организации не трогаются по построению. Нужен запущенный API в
// development/test (адрес — SA6_API_BASE).
const { call, login, SUITE } = require('./_lib.cjs');

const APPLY = process.argv.includes('--apply');

async function orphans(token, body) {
  const r = await call('POST', '/workspaces/dev/purge-orphans', token, body);
  if (!r.ok) throw new Error(`purge-orphans: ${r.status} ${r.code ?? ''} ${JSON.stringify(r.json?.message ?? '')}`);
  return r.json.data;
}

(async () => {
  const s = await login(SUITE.p1);
  const dry = await orphans(s.token, { apply: false });
  console.log(`Организаций, которых нет, а данные живы: ${dry.orphaned}`);
  for (const [k, v] of Object.entries(dry.report ?? {})) if (v > 0) console.log(`  ${k.padEnd(18)} ${v}`);
  if (!APPLY) {
    console.log('\nСухой прогон. Чтобы удалить: node scripts/gc-orphan-workspace-data.cjs --apply');
    return;
  }
  let left = dry.orphaned;
  let done = 0;
  while (left > 0) {
    const step = await orphans(s.token, { apply: true, limit: 20 });
    done += step.purged;
    const now = (await orphans(s.token, { apply: false })).orphaned;
    console.log(`  прибрано организаций: ${done}, осталось: ${now}`);
    // Хвосты обязаны убывать: иначе каскад на чём-то спотыкается (смотреть лог API)
    if (now >= left) {
      console.log('⚠ хвосты не убывают — смотрите лог API');
      process.exit(1);
    }
    left = now;
  }
  console.log('\nГотово.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
