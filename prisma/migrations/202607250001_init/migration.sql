CREATE TABLE "StreamRoute" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "RouteRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "routeId" TEXT NOT NULL,
    "pid" INTEGER,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "exitCode" INTEGER,
    "signal" TEXT,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RouteRun_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "StreamRoute" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "routeId" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "StreamRoute" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "StreamRoute_enabled_autoStart_idx" ON "StreamRoute"("enabled", "autoStart");
CREATE INDEX "RouteRun_routeId_createdAt_idx" ON "RouteRun"("routeId", "createdAt");
CREATE INDEX "AuditLog_routeId_createdAt_idx" ON "AuditLog"("routeId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
