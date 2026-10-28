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
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          !(event.target instanceof Element) ||
          !event.currentTarget.contains(event.target) ||
          event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="combobox"]')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="chat-panel-header">
        <strong>Chat</strong>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close chat"
          title="Close chat (Esc)"
          aria-keyshortcuts="Escape"
          onClick={onClose}
        >
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
