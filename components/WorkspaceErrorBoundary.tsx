import { Component, type ReactNode } from 'react';
import { RotateCcw, Inbox } from 'lucide-react';
import { Button } from './ui/button';

/** A failed review must not take the tab strip or other open reviews with it. */
export class WorkspaceErrorBoundary extends Component<
  {
    children: ReactNode;
    onQueue: () => void;
  },
  { error: Error | null; attempt: number }
> {
  state = { error: null as Error | null, attempt: 0 };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  render() {
    if (!this.state.error)
      return (
        <div key={this.state.attempt} className="workspace-content">
          {this.props.children}
        </div>
      );
    return (
      <section className="workspace-recovery" role="alert">
        <h1>This tab could not display the review</h1>
        <p>Your saved reviews and comments are kept. You can retry or open another tab.</p>
        <div className="workspace-recovery-actions">
          <Button onClick={() => this.setState(({ attempt }) => ({ error: null, attempt: attempt + 1 }))}>
            <RotateCcw size={15} /> Retry tab
          </Button>
          <Button variant="outline" onClick={this.props.onQueue}>
            <Inbox size={15} /> Review queue
          </Button>
        </div>
        <details>
          <summary>Error details</summary>
          <pre>{this.state.error.message}</pre>
        </details>
      </section>
    );
  }
}
