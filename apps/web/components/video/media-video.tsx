'use client';

import { cn } from '@app/ui';
import { Volume2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { getChatController, getLocalMedia, useLocalMedia } from '../../lib/chat.ts';

/**
 * Our own camera, mirrored and always muted (no echo). The stream is read from LocalMedia in
 * an effect — media objects never go through React state.
 */
export function LocalVideo({ className }: { className?: string }) {
  const { revision } = useLocalMedia();
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (video === null) return;
    const stream = getLocalMedia().getStream();
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream !== null) video.play().catch(() => undefined); // muted: always allowed
  }, [revision]);

  return (
    <video
      ref={ref}
      className={cn('size-full -scale-x-100 object-cover', className)}
      autoPlay
      playsInline
      muted
      aria-label="Your camera"
    />
  );
}

/**
 * A remote participant's media. `trackCount` changes when tracks arrive, which re-attaches
 * and re-plays the same stream. If the browser refuses autoplay with sound, it plays muted
 * and offers "Tap to unmute".
 */
export function RemoteVideo({
  participantId,
  trackCount,
}: {
  participantId: string;
  trackCount: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [needsTap, setNeedsTap] = useState(false);

  useEffect(() => {
    const video = ref.current;
    const stream = getChatController().remoteStream(participantId);
    if (video === null || stream === null) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== 'NotAllowedError') return;
      video.muted = true;
      video.play().then(
        () => {
          setNeedsTap(true);
        },
        () => undefined,
      );
    });
  }, [participantId, trackCount]);

  return (
    <>
      <video ref={ref} autoPlay playsInline aria-label="Stranger’s camera" />
      {needsTap && (
        <button
          type="button"
          className="absolute inset-x-0 bottom-12 mx-auto flex w-fit items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            const video = ref.current;
            if (video !== null) {
              video.muted = false;
              void video.play();
            }
            setNeedsTap(false);
          }}
        >
          <Volume2Icon className="size-4" aria-hidden /> Tap to unmute
        </button>
      )}
    </>
  );
}
