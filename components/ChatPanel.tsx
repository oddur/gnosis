import { useState, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui/button';
import { PanelResizeHandle } from './PanelResizeHandle';
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  CHAT_PANEL_STEP,
  rememberChatPanelWidth,
  rememberedChatPanelWidth,
  type ChatSurface,
} from '../lib/chat-preferences';
import { startupPreferences } from '../lib/startup-preferences';

/**
 * Shared shell for topic and file conversations, docked to the workspace's right edge. Its left edge resizes it; each
 * surface remembers its own width (lib/chat-preferences.ts).
 */
export function ChatPanel({
  children,
  context,
  contextTitle,
  label,
  onClose,
  surface,
  className = '',
  contained = false,
}: {
  children: ReactNode;
  context: ReactNode;
  contextTitle: string;
  label: string;
  onClose: () => void;
  surface: ChatSurface;
  className?: string;
  contained?: boolean;
}) {
  const [width, setWidth] = useState(() => rememberedChatPanelWidth(startupPreferences(), surface));
  return (
    <aside
      className={`chat-panel ${contained ? 'chat-panel-contained' : 'chat-panel-dock'} ${className}`}
      aria-label={label}
      data-open="true"
      data-chat-surface={surface}
      style={contained ? undefined : ({ '--chat-panel-width': `${width}px` } as CSSProperties)}
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
      {!contained && (
        <PanelResizeHandle
          className="chat-panel-resize"
          edge="start"
          label="Resize chat"
          width={width}
          min={CHAT_PANEL_MIN_WIDTH}
          max={CHAT_PANEL_MAX_WIDTH}
          step={CHAT_PANEL_STEP}
          onChange={setWidth}
          onCommit={(value) => void rememberChatPanelWidth(surface, value).catch(() => {})}
          onReset={() => {
            setWidth(CHAT_PANEL_DEFAULT_WIDTH);
            void rememberChatPanelWidth(surface, undefined).catch(() => {});
          }}
        />
      )}
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
