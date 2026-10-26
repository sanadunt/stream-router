import type { RouteStatus } from '../types';

export function StatusBadge({ status }: { status: RouteStatus }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{status}</span>;
}
