import React from 'react';
import { Button } from './Button';
import { Undo } from './Undo';
import { Share } from './Share';

export function Toolbar({ onSave }: { onSave: () => void }) {
  return (
    <div className="toolbar">
      <Button onClick={onSave}>Save</Button>
      <Undo />
      <Share />
    </div>
  );
}
