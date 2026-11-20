import React from 'react';
import { Button } from './Button';

export function Toolbar({ onSave }: { onSave: () => void }) {
  return (
    <div className="toolbar">
      <Button onClick={onSave}>Save</Button>
    </div>
  );
}
