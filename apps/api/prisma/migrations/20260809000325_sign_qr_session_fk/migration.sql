-- AddForeignKey
ALTER TABLE "sign_qr_sessions" ADD CONSTRAINT "sign_qr_sessions_act_id_fkey" FOREIGN KEY ("act_id") REFERENCES "sign_acts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
