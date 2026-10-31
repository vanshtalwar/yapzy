import { toast } from '@app/ui';

import { getLocalMedia } from '../../lib/chat.ts';

/** Switch camera or mic; failures (device busy, unplugged) become a toast. */
export function switchDevice(kind: 'audio' | 'video', deviceId: string): void {
  getLocalMedia()
    .selectDevice(kind, deviceId === '' ? null : deviceId)
    .catch(() => {
      toast(
        kind === 'video'
          ? 'That camera could not be opened.'
          : 'That microphone could not be opened.',
      );
    });
}
