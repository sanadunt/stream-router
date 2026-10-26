ALTER TABLE "StreamRoute" ADD COLUMN "localAudioMode" TEXT NOT NULL DEFAULT 'COPY';

UPDATE "AppSetting"
SET "value" = '3600'
WHERE "key" = 'recording.segmentDurationSeconds'
  AND CAST("value" AS INTEGER) < 3600;
