ALTER TABLE "StreamRoute" ADD COLUMN "cameraKey" TEXT;
ALTER TABLE "StreamRoute" ADD COLUMN "localViewEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StreamRoute" ADD COLUMN "onlineRelayEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StreamRoute" ADD COLUMN "recordingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StreamRoute" ADD COLUMN "recordingRetentionDays" INTEGER;

UPDATE "StreamRoute"
SET "cameraKey" = 'route-' || substr(replace("id", '-', ''), 1, 12)
WHERE "cameraKey" IS NULL;

CREATE UNIQUE INDEX "StreamRoute_cameraKey_key" ON "StreamRoute"("cameraKey");

CREATE TABLE "RecordingSegment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "routeId" TEXT,
  "cameraKey" TEXT NOT NULL,
  "cameraName" TEXT NOT NULL,
  "storageRoot" TEXT NOT NULL,
  "relativePath" TEXT NOT NULL,
  "startTime" DATETIME NOT NULL,
  "endTime" DATETIME NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'COMPLETE',
  "protected" BOOLEAN NOT NULL DEFAULT false,
  "deletionReason" TEXT,
  "deletedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RecordingSegment_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "StreamRoute" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RecordingSegment_storageRoot_relativePath_key"
ON "RecordingSegment"("storageRoot", "relativePath");
CREATE INDEX "RecordingSegment_routeId_startTime_idx"
ON "RecordingSegment"("routeId", "startTime");
CREATE INDEX "RecordingSegment_cameraKey_startTime_idx"
ON "RecordingSegment"("cameraKey", "startTime");
CREATE INDEX "RecordingSegment_status_protected_startTime_idx"
ON "RecordingSegment"("status", "protected", "startTime");
