import '@github/markdown-toolbar-element';
import { createElement, useId, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { Tabs } from 'radix-ui';
import {
  Bold,
  Italic,
  Code,
  Link,
  Quote,
  List,
  ListOrdered,
  ListTodo,
  FileCode2,
  MessageSquareCode,
} from 'lucide-react';
import { Button } from './ui/button';
import { CommentMarkdown } from './CommentMarkdown';

type Props = Omit<ComponentProps<'textarea'>, 'value' | 'onChange' | 'onInput' | 'ref'> & {
  value: string;
  onValueChange: (value: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
};
const commands = [
  ['bold', 'Bold', Bold],
  ['italic', 'Italic', Italic],
  ['code', 'Inline code', Code],
  ['link', 'Link', Link],
  ['quote', 'Quote', Quote],
  ['unordered-list', 'Bulleted list', List],
  ['ordered-list', 'Numbered list', ListOrdered],
  ['task-list', 'Task list', ListTodo],
] as const;

export function MarkdownCommentEditor({
  value,
  onValueChange,
  textareaRef,
  id: suppliedId,
  disabled,
  readOnly,
  rows = 4,
  maxLength = 65536,
  onKeyDown,
  ...props
}: Props) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const input = textareaRef ?? internalRef;
  const toolbar = useRef<HTMLElement>(null);
  const [mode, setMode] = useState('write');
  const [previewHeight, setPreviewHeight] = useState(120);
  const selection = useRef({ start: 0, end: 0, scroll: 0 });
  const unavailable = disabled || readOnly;
  function changeMode(next: string) {
    const field = input.current;
    if (next === 'preview' && field) {
      selection.current = { start: field.selectionStart, end: field.selectionEnd, scroll: field.scrollTop };
      setPreviewHeight(field.getBoundingClientRect().height);
    }
    setMode(next);
    if (next === 'write')
      requestAnimationFrame(() => {
        field?.focus({ preventScroll: true });
        field?.setSelectionRange(selection.current.start, selection.current.end);
        if (field) field.scrollTop = selection.current.scroll;
      });
  }
  function insertFence(language: string) {
    const field = input.current;
    if (!field || unavailable) return;
    const start = field.selectionStart,
      end = field.selectionEnd;
    // Use a fence longer than any backticks in the selection.
    const selected = field.value.slice(start, end);
    const ticks = '`'.repeat(Math.max(3, ...[...selected.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    const prefix = `${start && field.value[start - 1] !== '\n' ? '\n' : ''}${ticks}${language}\n`;
    const suffix = `\n${ticks}${field.value[end] === '\n' ? '' : '\n'}`;
    const text = prefix + selected + suffix;
    if (field.value.length - (end - start) + text.length > maxLength) return;
    field.focus({ preventScroll: true });
    // Chromium's native edit command keeps formatting in the textarea undo history.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Native edits preserve undo; setRangeText does not.
    if (!document.execCommand('insertText', false, text)) {
      field.setRangeText(text, start, end, 'end');
    }
    onValueChange(field.value);
    field.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
  }
  return (
    <Tabs.Root className="comment-editor" value={mode} onValueChange={changeMode}>
      <div className="comment-editor-header">
        <Tabs.List aria-label="Comment editor mode" className="comment-editor-tabs">
          <Tabs.Trigger value="write">Write</Tabs.Trigger>
          <Tabs.Trigger value="preview">Preview</Tabs.Trigger>
        </Tabs.List>
        {createElement(
          'markdown-toolbar',
          {
            for: id,
            ref: toolbar,
            className: 'comment-editor-toolbar',
            'aria-label': 'Markdown formatting',
            inert: unavailable || mode !== 'write' || undefined,
            'aria-hidden': mode !== 'write' || undefined,
            style: { visibility: mode === 'write' ? 'visible' : 'hidden' },
          },
          <>
            {commands.map(([command, label, Icon], index) => (
              <Button
                key={command}
                type="button"
                variant="ghost"
                size="icon-xs"
                data-md-button={command}
                aria-label={label}
                title={label}
                disabled={unavailable}
                tabIndex={index === 0 ? 0 : -1}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-md-button=""
              tabIndex={-1}
              aria-label="Code block"
              title="Code block"
              disabled={unavailable}
              onClick={() => insertFence('')}
            >
              <FileCode2 className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-md-button=""
              tabIndex={-1}
              aria-label="Suggested change"
              title="Suggested change"
              disabled={unavailable}
              onClick={() => insertFence('suggestion')}
            >
              <MessageSquareCode className="size-3.5" aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
      <Tabs.Content value="write" forceMount hidden={mode !== 'write'} className="comment-editor-panel">
        <textarea
          {...props}
          id={id}
          ref={input}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          rows={rows}
          maxLength={maxLength}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          onInput={(event) => onValueChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (
              !unavailable &&
              (event.metaKey || event.ctrlKey) &&
              !event.altKey &&
              ['b', 'i'].includes(event.key.toLowerCase())
            ) {
              event.preventDefault();
              const command = { b: 'bold', i: 'italic' }[event.key.toLowerCase()];
              toolbar.current?.querySelector<HTMLButtonElement>(`[data-md-button="${command}"]`)?.click();
              event.stopPropagation();
              return;
            }
            onKeyDown?.(event);
          }}
        />
      </Tabs.Content>
      <Tabs.Content
        value="preview"
        hidden={mode !== 'preview'}
        className="comment-editor-panel comment-editor-preview"
        style={{ height: previewHeight }}
      >
        {mode === 'preview' &&
          (value.trim() ? (
            <CommentMarkdown>{value}</CommentMarkdown>
          ) : (
            <p className="comment-editor-empty">Nothing to preview yet.</p>
          ))}
      </Tabs.Content>
    </Tabs.Root>
  );
}
