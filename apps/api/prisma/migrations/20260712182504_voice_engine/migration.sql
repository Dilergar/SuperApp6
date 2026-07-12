-- CreateTable
CREATE TABLE "voice_transcripts" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "language" TEXT,
    "detected_language" TEXT,
    "text" TEXT,
    "segments" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "duration_ms" INTEGER,
    "diarize" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "voice_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_recordings" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "language" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_transcripts_file_id_key" ON "voice_transcripts"("file_id");

-- CreateIndex
CREATE INDEX "voice_transcripts_status_updated_at_idx" ON "voice_transcripts"("status", "updated_at");

-- CreateIndex
CREATE INDEX "voice_recordings_owner_id_created_at_idx" ON "voice_recordings"("owner_id", "created_at");

-- AddForeignKey
ALTER TABLE "voice_transcripts" ADD CONSTRAINT "voice_transcripts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
