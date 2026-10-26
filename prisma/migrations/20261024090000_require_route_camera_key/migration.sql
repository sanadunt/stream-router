-- Selaraskan StreamRoute.cameraKey dengan schema.prisma (String @unique, NOT NULL).
-- Migration 20260728150000 menambahkan kolom sebagai TEXT nullable; NULL yang tersisa
-- diisi dengan pola Camera ID yang sama sebelum tabel didefinisikan ulang.
-- Runner mematikan foreign key sebelum transaksi, sehingga DROP TABLE di bawah tidak
-- menghapus RouteRun/subscription MQTT maupun melepas RecordingSegment/AuditLog.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StreamRoute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cameraKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "inputUrlEncrypted" TEXT NOT NULL,
    "inputProtocol" TEXT NOT NULL,
    "outputsEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoStart" BOOLEAN NOT NULL DEFAULT false,
    "localViewEnabled" BOOLEAN NOT NULL DEFAULT false,
    "localAudioMode" TEXT NOT NULL DEFAULT 'COPY',
    "onlineRelayEnabled" BOOLEAN NOT NULL DEFAULT true,
    "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "recordingRetentionMode" TEXT NOT NULL DEFAULT 'INHERIT',
    "recordingRetentionDays" INTEGER,
    "recordingRetentionGb" REAL,
    "ffmpegMode" TEXT NOT NULL DEFAULT 'COPY',
    "onlineAudioMode" TEXT NOT NULL DEFAULT 'COPY',
    "ffmpegOptions" TEXT NOT NULL DEFAULT '{}',
    "retryPolicy" TEXT NOT NULL DEFAULT '{}',
    "webrtcEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webrtcUrlEncrypted" TEXT,
    "webrtcMode" TEXT NOT NULL DEFAULT 'IFRAME',
    "ptzEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ptzProvider" TEXT NOT NULL DEFAULT 'NONE',
    "ptzZoomEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ptzConfigEncrypted" TEXT,
    "ptzMqttBrokerId" TEXT,
    "mqttBridgeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StreamRoute_ptzMqttBrokerId_fkey" FOREIGN KEY ("ptzMqttBrokerId") REFERENCES "MqttBroker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_StreamRoute" ("autoStart", "cameraKey", "createdAt", "description", "enabled", "ffmpegMode", "ffmpegOptions", "id", "inputProtocol", "inputUrlEncrypted", "localAudioMode", "localViewEnabled", "mqttBridgeEnabled", "name", "onlineAudioMode", "onlineRelayEnabled", "outputsEncrypted", "ptzConfigEncrypted", "ptzEnabled", "ptzMqttBrokerId", "ptzProvider", "ptzZoomEnabled", "recordingEnabled", "recordingRetentionDays", "recordingRetentionGb", "recordingRetentionMode", "retryPolicy", "updatedAt", "webrtcEnabled", "webrtcMode", "webrtcUrlEncrypted") SELECT "autoStart", COALESCE("cameraKey", 'route-' || substr(replace("id", '-', ''), 1, 12)), "createdAt", "description", "enabled", "ffmpegMode", "ffmpegOptions", "id", "inputProtocol", "inputUrlEncrypted", "localAudioMode", "localViewEnabled", "mqttBridgeEnabled", "name", "onlineAudioMode", "onlineRelayEnabled", "outputsEncrypted", "ptzConfigEncrypted", "ptzEnabled", "ptzMqttBrokerId", "ptzProvider", "ptzZoomEnabled", "recordingEnabled", "recordingRetentionDays", "recordingRetentionGb", "recordingRetentionMode", "retryPolicy", "updatedAt", "webrtcEnabled", "webrtcMode", "webrtcUrlEncrypted" FROM "StreamRoute";
DROP TABLE "StreamRoute";
ALTER TABLE "new_StreamRoute" RENAME TO "StreamRoute";
CREATE UNIQUE INDEX "StreamRoute_cameraKey_key" ON "StreamRoute"("cameraKey");
CREATE INDEX "StreamRoute_enabled_autoStart_idx" ON "StreamRoute"("enabled", "autoStart");
CREATE INDEX "StreamRoute_ptzMqttBrokerId_idx" ON "StreamRoute"("ptzMqttBrokerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
