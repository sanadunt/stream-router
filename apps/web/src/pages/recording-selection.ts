export interface RecordingSelectionItem {
  id: string;
}

export const MAX_RECORDING_BULK_SELECTION = 100;

export function toggleRecordingPageSelection<T extends RecordingSelectionItem>(
  selectedItems: T[],
  pageItems: T[]
): T[] {
  if (pageItems.length === 0) return [...selectedItems];

  const pageIds = new Set(pageItems.map((item) => item.id));
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const allPageSelected = pageItems.every((item) => selectedIds.has(item.id));
  if (allPageSelected) {
    return selectedItems.filter((item) => !pageIds.has(item.id));
  }

  if (selectedItems.length + pageItems.filter((item) => !selectedIds.has(item.id)).length > MAX_RECORDING_BULK_SELECTION) {
    return [...selectedItems];
  }

  const currentPageById = new Map(pageItems.map((item) => [item.id, item]));
  const nextSelected = selectedItems.map((item) => currentPageById.get(item.id) ?? item);
  const nextIds = new Set(nextSelected.map((item) => item.id));
  for (const item of pageItems) {
    if (!nextIds.has(item.id)) {
      nextSelected.push(item);
      nextIds.add(item.id);
    }
  }
  return nextSelected;
}
