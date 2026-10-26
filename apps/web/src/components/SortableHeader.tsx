export type SortDirection = 'asc' | 'desc';

export function SortableHeader({
  label,
  active,
  direction,
  onSort
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
}) {
  const ariaSort = active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return <th aria-sort={ariaSort}>
    <button className={`sort-header ${active ? 'sort-header-active' : ''}`} type="button" onClick={onSort}>
      <span>{label}</span>
      <span className="sort-indicator" aria-hidden="true">{active ? (direction === 'asc' ? '▲' : '▼') : '◇'}</span>
    </button>
  </th>;
}

export function compareSortValues(left: string | number | boolean | null | undefined, right: string | number | boolean | null | undefined): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left ?? '').localeCompare(String(right ?? ''), 'id-ID', { numeric: true, sensitivity: 'base' });
}
