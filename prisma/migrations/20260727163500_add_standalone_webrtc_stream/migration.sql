CREATE TABLE "WebrtcStream" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "urlEncrypted" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'IFRAME',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "WebrtcStream_enabled_name_idx" ON "WebrtcStream"("enabled", "name");
