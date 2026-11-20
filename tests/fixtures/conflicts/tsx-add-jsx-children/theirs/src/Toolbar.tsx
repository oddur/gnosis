import React from 'react';
import { Button } from './Button';
import { Share } from './Share';

export function Toolbar({ onSave }: { onSave: () => void }) {
  return (
    <div className="toolbar">
      <Button onClick={onSave}>Save</Button>
      <Share />
    </div>
  );
}
