import { readItem, writeItem } from './storage.ts';

const KEY = 'rc.acceptedTos';

/** The ToS version this browser last accepted (pre-checks the gate for returning visitors). */
export function getAcceptedTosVersion(): string | null {
  return readItem('local', KEY);
}

export function setAcceptedTosVersion(version: string): void {
  writeItem('local', KEY, version);
}
