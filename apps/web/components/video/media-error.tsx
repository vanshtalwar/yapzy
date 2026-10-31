import { CameraOffIcon } from 'lucide-react';

import { type MediaErrorKind } from '../../lib/rtc/local-media.ts';

const MESSAGES: Record<MediaErrorKind, { title: string; body: string }> = {
  denied: {
    title: 'Camera and microphone are blocked',
    body: 'Allow access with the camera icon in your browser’s address bar, then try again.',
  },
  'no-device': {
    title: 'No camera or microphone found',
    body: 'Connect a camera and a microphone, then try again.',
  },
  'in-use': {
    title: 'Your camera or microphone is busy',
    body: 'Close other apps or tabs that are using them, then try again.',
  },
  insecure: {
    title: 'Video needs a secure connection',
    body: 'Open RandomChat over https:// (or on localhost) to use your camera.',
  },
  unknown: {
    title: 'Your camera could not be started',
    body: 'Please try again. If it keeps failing, restart your browser.',
  },
};

export function MediaError({ kind }: { kind: MediaErrorKind }) {
  const { title, body } = MESSAGES[kind];
  return (
    <div role="alert" className="flex flex-col items-center gap-2 text-center">
      <CameraOffIcon className="size-8 text-destructive" aria-hidden />
      <p className="font-medium">{title}</p>
      <p className="max-w-xs text-sm opacity-80">{body}</p>
    </div>
  );
}
