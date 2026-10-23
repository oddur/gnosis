import { useState } from 'react';
import { SettingsDialog } from '../../components/SettingsDialog';
import { SlideChatSheet } from '../../components/SlideChatSheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/dialog';

export function HardeningFixture() {
  const [settings, setSettings] = useState(false);
  const [longDialog, setLongDialog] = useState(false);
  const [chat, setChat] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [sent, setSent] = useState<string[]>([]);
  return (
    <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <nav style={{ display: 'flex', gap: 20, padding: 12 }}>
        <button onClick={() => setSettings(true)}>Open settings</button>
        <button onClick={() => setLongDialog(true)}>Open long dialog</button>
        <button onClick={() => setStreaming((value) => !value)}>Toggle streaming</button>
      </nav>
      <output id="sent-count">{sent.length}</output>
      <div style={{ display: 'flex', justifyContent: 'flex-end', flex: 1, minHeight: 0 }}>
        <SlideChatSheet
          open={chat}
          onOpenChange={setChat}
          slideTitle="Cancellation and cleanup — 日本語 العربية 🧪"
          reviewFocus={null}
          messages={[]}
          isStreaming={streaming}
          onSend={(text) => setSent((current) => [...current, text])}
        />
      </div>
      <SettingsDialog open={settings} onOpenChange={setSettings} />
      <Dialog open={longDialog} onOpenChange={setLongDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Review recovery for a repository with a very long name and an expanded explanation
            </DialogTitle>
            <DialogDescription>{'組織/مستودع/' + 'repository-with-a-long-name-'.repeat(10)}</DialogDescription>
          </DialogHeader>
          {Array.from({ length: 12 }, (_, i) => (
            <p key={i}>Keep the draft while retrying the request. Änderungen bleiben erhalten. 変更を保持します。</p>
          ))}
          <button onClick={() => setLongDialog(false)}>Return to review</button>
        </DialogContent>
      </Dialog>
    </main>
  );
}
