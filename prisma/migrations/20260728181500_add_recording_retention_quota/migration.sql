ALTER TABLE "StreamRoute" ADD COLUMN "recordingRetentionMode" TEXT NOT NULL DEFAULT 'INHERIT';
ALTER TABLE "StreamRoute" ADD COLUMN "recordingRetentionGb" REAL;
