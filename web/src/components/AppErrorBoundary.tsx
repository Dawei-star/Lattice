import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/** 错误边界属性。 */
export interface AppErrorBoundaryProps {
  children?: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/** 防止非首屏模块加载或渲染失败时把整个工作台变成白屏。 */
export default class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the diagnostic local; production UI must not expose stack traces.
    console.error('Lattice UI render failed', error, info);
  }

  handleReload = (): void => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-error" role="alert">
        <div className="app-error__content">
          <span className="app-error__eyebrow">LATTICE / RECOVERY</span>
          <h1>这个界面暂时无法加载</h1>
          <p>工作区数据仍保留在本地。刷新页面后可以重新加载当前模块。</p>
          <button type="button" className="btn btn--primary" onClick={this.handleReload}>刷新页面</button>
        </div>
      </main>
    );
  }
}
