'use client';

import {
  DeviceFields,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@app/ui';

import { useLocalMedia } from '../../lib/chat.ts';
import { useAudioLevel } from '../../lib/rtc/use-audio-level.ts';
import { switchDevice } from './device-controls.ts';

export function DeviceSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const media = useLocalMedia();
  const level = useAudioLevel(open && media.status === 'ready', media.revision);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Camera & microphone</DialogTitle>
          <DialogDescription>Changes apply immediately, also during a call.</DialogDescription>
        </DialogHeader>
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
          disabled={media.status !== 'ready'}
        />
      </DialogContent>
    </Dialog>
  );
}
