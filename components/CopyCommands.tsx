import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from './ui/button';

/** Commands for the reader's own clone, with Copy commands: the next step when Gnosis can't do the work itself. */
export function CopyCommands({ commands }: { commands: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="conflict-commands" data-conflict-commands="">
      <pre className="selectable">{commands}</pre>
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(commands).then(
              () => setCopied(true),
              () => setCopied(false)
            )
          }
        >
          <Copy aria-hidden="true" />
          {copied ? 'Copied' : 'Copy commands'}
        </Button>
      </div>
    </div>
  );
}
