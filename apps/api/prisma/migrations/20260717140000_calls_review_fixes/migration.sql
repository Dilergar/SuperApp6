-- Ревью-фиксы движка звонков (2026-07-17).

-- (1) Идемпотентность итоговой плашки звонка: клейм «плашка уже постнута».
ALTER TABLE "call_sessions" ADD COLUMN "summarized_at" TIMESTAMP(3);

-- (2) Одна ОТКРЫТАЯ строка журнала на (сессия, пользователь): повторная доставка
--     вебхука participant_joined (at-least-once) больше не плодит дублей «внутри».
CREATE UNIQUE INDEX "call_session_participants_one_open_per_user"
    ON "call_session_participants"("session_id", "user_id") WHERE "left_at" IS NULL;
