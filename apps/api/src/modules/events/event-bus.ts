import { EventEmitter } from 'node:events';

export interface AppEvent {
  type: string;
  routeId?: string;
  timestamp: string;
  data: unknown;
}

class EventBus extends EventEmitter {
  publish(event: Omit<AppEvent, 'timestamp'>): void {
    this.emit('event', { ...event, timestamp: new Date().toISOString() } satisfies AppEvent);
  }
}

export const eventBus = new EventBus();
eventBus.setMaxListeners(500);
