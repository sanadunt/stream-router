-- CreateTable
CREATE TABLE "MonitoringLayout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "layout" TEXT NOT NULL DEFAULT '1',
    "slots" TEXT NOT NULL DEFAULT '[]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StreamRoute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "inputUrlEncrypted" TEXT NOT NULL,
    "inputProtocol" TEXT NOT NULL,
    "outputsEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoStart" BOOLEAN NOT NULL DEFAULT false,
    "ffmpegMode" TEXT NOT NULL DEFAULT 'COPY',
    "ffmpegOptions" TEXT NOT NULL DEFAULT '{}',
    "retryPolicy" TEXT NOT NULL DEFAULT '{}',
    "webrtcEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webrtcUrlEncrypted" TEXT,
    "webrtcMode" TEXT NOT NULL DEFAULT 'IFRAME',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_StreamRoute" ("autoStart", "createdAt", "enabled", "ffmpegMode", "ffmpegOptions", "id", "inputProtocol", "inputUrlEncrypted", "name", "outputsEncrypted", "retryPolicy", "updatedAt") SELECT "autoStart", "createdAt", "enabled", "ffmpegMode", "ffmpegOptions", "id", "inputProtocol", "inputUrlEncrypted", "name", "outputsEncrypted", "retryPolicy", "updatedAt" FROM "StreamRoute";
DROP TABLE "StreamRoute";
ALTER TABLE "new_StreamRoute" RENAME TO "StreamRoute";
CREATE INDEX "StreamRoute_enabled_autoStart_idx" ON "StreamRoute"("enabled", "autoStart");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MonitoringLayout_isDefault_idx" ON "MonitoringLayout"("isDefault");
