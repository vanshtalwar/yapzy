'use client';

import {
  Button,
  CallControlButton,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DeviceFields,
  Spinner,
  VideoTile,
} from '@app/ui';
import { MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from 'lucide-react';
import Link from 'next/link';

import { getLocalMedia, useLocalMedia } from '../../lib/chat.ts';
import { useAudioLevel } from '../../lib/rtc/use-audio-level.ts';
import { switchDevice } from './device-controls.ts';
import { MediaError } from './media-error.tsx';
import { LocalVideo } from './media-video.tsx';

/**
 * Camera/mic check before queueing: nobody enters the video queue without working media
 * (D-049). Shows the preview, device pickers and a mic meter; "Start" only once ready.
 */
export function PreJoin({ onStart }: { onStart: () => void }) {
  const media = useLocalMedia();
  const ready = media.status === 'ready';
  const level = useAudioLevel(ready, media.revision);

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 md:grid-cols-[3fr_2fr] md:items-start">
      <VideoTile
        className="aspect-[4/3] md:aspect-video"
        label={ready ? 'You' : undefined}
        placeholder={
          ready ? undefined : media.status === 'error' && media.error !== null ? (
            <MediaError kind={media.error} />
          ) : (
            <>
              <Spinner label="Starting camera" />
              <span>Allow camera and microphone access to continue…</span>
            </>
          )
        }
        overlay={
          ready ? (
            <div className="absolute right-0 bottom-2 left-0 flex justify-center gap-2">
              <CallControlButton
                icon={media.audioEnabled ? <MicIcon /> : <MicOffIcon />}
                label={media.audioEnabled ? 'Mute' : 'Unmute'}
                tone={media.audioEnabled ? 'default' : 'off'}
                pressed={!media.audioEnabled}
                className="[&>span:last-child]:sr-only"
                onClick={() => {
                  getLocalMedia().setAudioEnabled(!media.audioEnabled);
                }}
              />
              <CallControlButton
                icon={media.videoEnabled ? <VideoIcon /> : <VideoOffIcon />}
                label={media.videoEnabled ? 'Camera off' : 'Camera on'}
                tone={media.videoEnabled ? 'default' : 'off'}
                pressed={!media.videoEnabled}
                className="[&>span:last-child]:sr-only"
                onClick={() => {
                  getLocalMedia().setVideoEnabled(!media.videoEnabled);
                }}
              />
            </div>
          ) : undefined
        }
      >
        {ready && <LocalVideo />}
      </VideoTile>

      <Card>
        <CardHeader>
          <CardTitle>Ready to meet someone?</CardTitle>
          <CardDescription>
            Check that the stranger will see and hear you, then start.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <DeviceFields
            cameras={media.cameras}
            microphones={media.microphones}
            cameraId={media.cameraId}
            microphoneId={media.microphoneId}
            onCameraChange={(deviceId) => {
              switchDevice('video', deviceId);
            }}
            onMicrophoneChange={(deviceId) => {
              switchDevice('audio', deviceId);
            }}
            level={level}
            disabled={!ready}
          />
          {media.status === 'error' ? (
            <Button
              size="lg"
              onClick={() => {
                void getLocalMedia().acquire();
              }}
            >
              Try again
            </Button>
          ) : (
            <Button size="lg" disabled={!ready} onClick={onStart}>
              <VideoIcon aria-hidden /> Start video chat
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Strangers can see and hear you. Be kind — video calls may be checked for safety.{' '}
            <Link
              className="underline underline-offset-2 hover:text-primary"
              href="/chat?mode=text"
            >
              Prefer to type?
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
