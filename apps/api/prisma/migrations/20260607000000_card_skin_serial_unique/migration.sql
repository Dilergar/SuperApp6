-- Defense-in-depth: a limited skin can't issue the same serial twice.
-- NULL serials (unlimited skins) are treated as distinct by Postgres → unaffected.
-- CreateIndex
CREATE UNIQUE INDEX "card_skin_instances_skin_serial_key" ON "card_skin_instances"("skin_id", "serial");
