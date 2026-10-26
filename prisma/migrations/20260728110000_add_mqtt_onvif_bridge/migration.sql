ALTER TABLE "StreamRoute" ADD COLUMN "mqttBridgeEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MqttBroker" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "protocol" TEXT NOT NULL DEFAULT 'mqtt',
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 1883,
  "path" TEXT NOT NULL DEFAULT '/mqtt',
  "username" TEXT NOT NULL DEFAULT '',
  "passwordEncrypted" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "MqttBroker_name_key" ON "MqttBroker"("name");
CREATE INDEX "MqttBroker_name_idx" ON "MqttBroker"("name");

CREATE TABLE "RouteMqttBridgeSubscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "routeId" TEXT NOT NULL,
  "brokerId" TEXT NOT NULL,
  "commandTopic" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RouteMqttBridgeSubscription_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "StreamRoute" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RouteMqttBridgeSubscription_brokerId_fkey"
    FOREIGN KEY ("brokerId") REFERENCES "MqttBroker" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RouteMqttBridgeSubscription_routeId_brokerId_key"
  ON "RouteMqttBridgeSubscription"("routeId", "brokerId");
CREATE UNIQUE INDEX "RouteMqttBridgeSubscription_brokerId_commandTopic_key"
  ON "RouteMqttBridgeSubscription"("brokerId", "commandTopic");
CREATE INDEX "RouteMqttBridgeSubscription_routeId_idx"
  ON "RouteMqttBridgeSubscription"("routeId");
CREATE INDEX "RouteMqttBridgeSubscription_brokerId_idx"
  ON "RouteMqttBridgeSubscription"("brokerId");
