import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Berganti saat pengguna pindah halaman, sehingga halaman lain tetap dapat dibuka. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Tanpa boundary, satu error render di halaman mana pun membuat React melepas seluruh
 * aplikasi (layar kosong) termasuk navigasi dan tombol logout.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Halaman gagal dirender:', error, info.componentStack);
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <div className="alert error" role="alert">
      Halaman ini gagal ditampilkan: {this.state.error.message}{' '}
      <button type="button" onClick={() => this.setState({ error: null })}>Coba lagi</button>{' '}
      <button type="button" onClick={() => window.location.reload()}>Muat ulang aplikasi</button>
    </div>;
  }
}
