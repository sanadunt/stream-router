ALTER TABLE "StreamRoute" ADD COLUMN "onlineAudioMode" TEXT NOT NULL DEFAULT 'COPY';

UPDATE "StreamRoute"
SET "onlineAudioMode" = 'AAC'
WHERE "ffmpegMode" = 'TRANSCODE';
