import { describe, expect, it } from 'vitest';
import { MAX_RECORDING_BULK_SELECTION, toggleRecordingPageSelection } from './recording-selection';

type Item = { id: string; status: string };

const pageOne: Item = { id: 'recording-page-1', status: 'COMPLETE' };
const pageTwo: Item = { id: 'recording-page-2', status: 'COMPLETE' };
const otherPage: Item = { id: 'recording-other-page', status: 'COMPLETE' };

describe('recording page selection', () => {
  it('menambahkan item halaman aktif tanpa menghapus selection dari halaman lain', () => {
    expect(toggleRecordingPageSelection(
      [pageOne, otherPage],
      [pageOne, pageTwo]
    )).toEqual([pageOne, otherPage, pageTwo]);
  });

  it('menghapus hanya item halaman aktif saat semua item halaman itu sudah terpilih', () => {
    expect(toggleRecordingPageSelection(
      [pageOne, pageTwo, otherPage],
      [pageOne, pageTwo]
    )).toEqual([otherPage]);
  });

  it('tidak mengubah selection ketika halaman aktif kosong', () => {
    expect(toggleRecordingPageSelection([otherPage], [])).toEqual([otherPage]);
  });

  it('menolak penambahan yang membuat bulk selection melewati limit API', () => {
    const selected = Array.from({ length: MAX_RECORDING_BULK_SELECTION }, (_, index) => ({ id: `selected-${index}` }));
    expect(toggleRecordingPageSelection(selected, [otherPage])).toEqual(selected);
  });
});
