ALTER TABLE "MqttBroker" ADD COLUMN "rootTopic" TEXT NOT NULL DEFAULT 'Turjawali';

ALTER TABLE "StreamRoute" ADD COLUMN "ptzMqttBrokerId" TEXT
  REFERENCES "MqttBroker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WebrtcStream" ADD COLUMN "ptzMqttBrokerId" TEXT
  REFERENCES "MqttBroker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "StreamRoute_ptzMqttBrokerId_idx" ON "StreamRoute"("ptzMqttBrokerId");
CREATE INDEX "WebrtcStream_ptzMqttBrokerId_idx" ON "WebrtcStream"("ptzMqttBrokerId");
