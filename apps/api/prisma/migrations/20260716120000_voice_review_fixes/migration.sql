-- Ревью-фиксы голосового движка (2026-07-16):
-- 1) Аренда джоба транскрипции: клейм ставит leaseUntil = now + бюджет джоба
--    (overhead + STT-таймаут + запас); крон переклеймивает processing только с
--    протухшей арендой — живой длинный джоб больше не задваивается.
ALTER TABLE "voice_transcripts" ADD COLUMN "lease_until" TIMESTAMP(3);

CREATE INDEX "voice_transcripts_status_lease_until_idx" ON "voice_transcripts"("status", "lease_until");

-- 2) VoiceRecording.duration_ms был вторым источником правды (снимок meta файла,
--    который чтение всё равно обходило фолбэком) — длительность теперь всегда
--    берётся из meta файла с добором из транскрипта.
ALTER TABLE "voice_recordings" DROP COLUMN "duration_ms";
