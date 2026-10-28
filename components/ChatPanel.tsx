import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui/button';

/** Shared shell for topic and file conversations, docked to the workspace's right edge. */
export function ChatPanel({
  children,
  context,
  contextTitle,
  label,
  onClose,
  className = '',
  contained = false,
}: {
  children: ReactNode;
  context: ReactNode;
  contextTitle: string;
  label: string;
  onClose: () => void;
  className?: string;
  contained?: boolean;
}) {
  return (
    <aside
      className={`chat-panel ${contained ? 'chat-panel-contained' : 'chat-panel-dock'} ${className}`}
      aria-label={label}
      data-open="true"
    >
      <header className="chat-panel-header">
        <strong>Chat</strong>
        <Button variant="ghost" size="icon-sm" aria-label="Close chat" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>
      <div className="chat-panel-context" title={contextTitle} tabIndex={0}>
        {context}
      </div>
      {children}
    </aside>
  );
}
