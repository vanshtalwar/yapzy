'use client';

import { useId } from 'react';

import { Label } from '../label.tsx';
import { NativeSelect } from '../select.tsx';
import { LevelMeter } from './level-meter.tsx';

export interface DeviceChoice {
  deviceId: string;
  label: string;
}

export interface DeviceFieldsProps {
  cameras: DeviceChoice[];
  microphones: DeviceChoice[];
  cameraId: string | null;
  microphoneId: string | null;
  onCameraChange: (deviceId: string) => void;
  onMicrophoneChange: (deviceId: string) => void;
  /** Microphone input level 0–1 (omit to hide the meter). */
  level?: number;
  disabled?: boolean;
}

/** Camera + microphone pickers (native selects) with an optional mic level meter. */
export function DeviceFields({
  cameras,
  microphones,
  cameraId,
  microphoneId,
  onCameraChange,
  onMicrophoneChange,
  level,
  disabled = false,
}: DeviceFieldsProps) {
  const cameraField = useId();
  const microphoneField = useId();
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor={cameraField}>Camera</Label>
        <NativeSelect
          id={cameraField}
          value={cameraId ?? ''}
          disabled={disabled || cameras.length === 0}
          onChange={(event) => {
            onCameraChange(event.target.value);
          }}
        >
          {cameras.length === 0 && <option value="">No camera found</option>}
          {cameras.map((camera) => (
            <option key={camera.deviceId} value={camera.deviceId}>
              {camera.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={microphoneField}>Microphone</Label>
        <NativeSelect
          id={microphoneField}
          value={microphoneId ?? ''}
          disabled={disabled || microphones.length === 0}
          onChange={(event) => {
            onMicrophoneChange(event.target.value);
          }}
        >
          {microphones.length === 0 && <option value="">No microphone found</option>}
          {microphones.map((microphone) => (
            <option key={microphone.deviceId} value={microphone.deviceId}>
              {microphone.label}
            </option>
          ))}
        </NativeSelect>
        {level !== undefined && <LevelMeter level={level} className="mt-1" />}
      </div>
    </div>
  );
}
