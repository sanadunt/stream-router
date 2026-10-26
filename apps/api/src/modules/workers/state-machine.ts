import type { RouteStatus } from '@stream-router/contracts';

const transitions: Record<RouteStatus, RouteStatus[]> = {
  DISABLED: ['STOPPED'],
  STOPPED: ['STARTING', 'DISABLED'],
  STARTING: ['RUNNING', 'FAILED', 'RESTARTING', 'STOPPING'],
  RUNNING: ['STOPPING', 'RESTARTING', 'FAILED'],
  RESTARTING: ['STARTING', 'FAILED', 'STOPPING'],
  FAILED: ['STARTING', 'STOPPED', 'DISABLED'],
  STOPPING: ['STOPPED', 'FAILED']
};

export function canTransition(from: RouteStatus, to: RouteStatus): boolean {
  return from === to || transitions[from]!.includes(to);
}
