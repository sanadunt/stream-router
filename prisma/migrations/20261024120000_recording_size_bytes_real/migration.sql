-- Kolom "sizeBytes" sebelumnya INTEGER yang dibaca Prisma sebagai Int 32-bit: satu
-- segment di atas 2 GiB (segment 1 jam di atas ~4,8 Mbps) membuat setiap query yang
-- membaca baris tersebut gagal, sehingga retention dan storage guard berhenti.
-- SQLite tidak dapat mengubah tipe kolom, jadi tabel didefinisikan ulang dengan
-- "sizeBytes" REAL (Prisma Float, presisi bulat hingga 2^53). Tidak ada tabel yang
-- mereferensikan RecordingSegment, sehingga DROP tabel lama tidak meng-cascade apa pun.
CREATE TABLE "new_RecordingSegment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "routeId" TEXT,
  "cameraKey" TEXT NOT NULL,
  "cameraName" TEXT NOT NULL,
  "storageRoot" TEXT NOT NULL,
  "relativePath" TEXT NOT NULL,
  "startTime" DATETIME NOT NULL,
  "endTime" DATETIME NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "sizeBytes" REAL NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'COMPLETE',
  "protected" BOOLEAN NOT NULL DEFAULT false,
  "deletionReason" TEXT,
  "errorMessage" TEXT,
  "deletedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RecordingSegment_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "StreamRoute" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Subquery routeId mengubah referensi route yang sudah tidak ada menjadi NULL (hasil
-- yang sama dengan ON DELETE SET NULL), agar penyalinan tidak gagal di foreign key.
INSERT INTO "new_RecordingSegment" (
  "id", "routeId", "cameraKey", "cameraName", "storageRoot", "relativePath",
  "startTime", "endTime", "durationMs", "sizeBytes", "status", "protected",
  "deletionReason", "errorMessage", "deletedAt", "createdAt", "updatedAt"
)
SELECT
  "segment"."id",
  (SELECT "route"."id" FROM "StreamRoute" AS "route" WHERE "route"."id" = "segment"."routeId"),
  "segment"."cameraKey", "segment"."cameraName", "segment"."storageRoot", "segment"."relativePath",
  "segment"."startTime", "segment"."endTime", "segment"."durationMs", CAST("segment"."sizeBytes" AS REAL),
  "segment"."status", "segment"."protected", "segment"."deletionReason", "segment"."errorMessage",
  "segment"."deletedAt", "segment"."createdAt", "segment"."updatedAt"
FROM "RecordingSegment" AS "segment";

DROP TABLE "RecordingSegment";
ALTER TABLE "new_RecordingSegment" RENAME TO "RecordingSegment";

CREATE UNIQUE INDEX "RecordingSegment_storageRoot_relativePath_key"
ON "RecordingSegment"("storageRoot", "relativePath");
CREATE INDEX "RecordingSegment_routeId_startTime_idx"
ON "RecordingSegment"("routeId", "startTime");
CREATE INDEX "RecordingSegment_cameraKey_startTime_idx"
ON "RecordingSegment"("cameraKey", "startTime");
CREATE INDEX "RecordingSegment_status_protected_startTime_idx"
ON "RecordingSegment"("status", "protected", "startTime");
