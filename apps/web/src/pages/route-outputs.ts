/** Baris output dari textarea editor: satu URL per baris, baris kosong diabaikan. */
export function parseOutputLines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

/** Output yang muncul lebih dari sekali; API menolaknya karena RTMP server menolak publish kedua. */
export function duplicateOutputs(outputs: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const output of outputs) {
    if (seen.has(output)) duplicates.add(output);
    seen.add(output);
  }
  return [...duplicates];
}
