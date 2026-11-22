import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from './ui/button';

/** Commands for the reader's own clone, with Copy commands: the next step when Gnosis can't do the work itself. */
export function CopyCommands({ commands }: { commands: string }) {
  const [copied, setCopied] = useState(false);
  // "Copied" is a moment's confirmation: the button reads Copy commands again, ready for the next copy.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
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
