-- core/jobs Волна 3 (Voice STT): исполнение транскрипции переехало на движок джобов.
-- Аренда/редрайв теперь у движка (таблица jobs.lease_until) — колонка транскрипта
-- больше не нужна. Postgres авто-дропнет зависимый индекс
-- voice_transcripts_status_lease_until_idx вместе с колонкой.
ALTER TABLE "voice_transcripts" DROP COLUMN "lease_until";
