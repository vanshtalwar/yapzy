export type MediaErrorKind = 'denied' | 'no-device' | 'in-use' | 'insecure' | 'unknown';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface LocalMediaSnapshot {
  status: 'idle' | 'requesting' | 'ready' | 'error';
  error: MediaErrorKind | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
  cameras: DeviceOption[];
  microphones: DeviceOption[];
  cameraId: string | null;
  microphoneId: string | null;
  /** Bumps whenever the stream or its tracks change (re-attach previews). */
  revision: number;
}

type Kind = 'audio' | 'video';

/** Ideal 640×480 at up to 30 fps; voice processing on. */
const VIDEO: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 30, max: 30 },
};
const AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function constraintsFor(kind: Kind, deviceId: string | null): MediaTrackConstraints {
  const base = kind === 'video' ? VIDEO : AUDIO;
  return deviceId === null ? base : { ...base, deviceId: { exact: deviceId } };
}

export function classifyMediaError(error: unknown): MediaErrorKind {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-device';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'unknown';
  }
}

const INITIAL: LocalMediaSnapshot = {
  status: 'idle',
  error: null,
  audioEnabled: true,
  videoEnabled: true,
  cameras: [],
  microphones: [],
  cameraId: null,
  microphoneId: null,
  revision: 0,
};

/**
 * Camera + microphone for the whole tab: acquired once, reused by every call, switched with
 * `replaceTrack`. Mute / camera-off only toggle `track.enabled` (the peer gets silence /
 * black frames, no renegotiation). Exposes a plain snapshot for `useSyncExternalStore`.
 */
export class LocalMedia {
  private readonly devices: MediaDevices | undefined;
  private stream: MediaStream | null = null;
  private snapshot: LocalMediaSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly trackListeners = new Set<(track: MediaStreamTrack) => void>();
  private acquiring: Promise<boolean> | null = null;
  private watchingDevices = false;

  constructor(devices?: MediaDevices) {
    this.devices =
      devices ?? (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices);
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  readonly getSnapshot = (): LocalMediaSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Called with the new track after a device switch (calls swap it in with replaceTrack). */
  onTrackReplaced(listener: (track: MediaStreamTrack) => void): () => void {
    this.trackListeners.add(listener);
    return () => {
      this.trackListeners.delete(listener);
    };
  }

  /** Asks for camera + mic once; later calls reuse the stream. Resolves to success. */
  acquire(): Promise<boolean> {
    if (this.stream !== null) return Promise.resolve(true);
    this.acquiring ??= this.doAcquire().finally(() => {
      this.acquiring = null;
    });
    return this.acquiring;
  }

  setAudioEnabled(enabled: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = enabled;
    this.update({ audioEnabled: enabled });
  }

  setVideoEnabled(enabled: boolean): void {
    for (const track of this.stream?.getVideoTracks() ?? []) track.enabled = enabled;
    this.update({ videoEnabled: enabled });
  }

  /** Switches camera or mic; `null` = system default. Throws if the device can't be opened. */
  async selectDevice(kind: Kind, deviceId: string | null): Promise<void> {
    const stream = this.stream;
    if (stream === null || this.devices === undefined) {
      this.update(kind === 'video' ? { cameraId: deviceId } : { microphoneId: deviceId });
      return;
    }
    const fresh = await this.devices.getUserMedia({ [kind]: constraintsFor(kind, deviceId) });
    const track = fresh.getTracks()[0];
    if (track === undefined) return;
    this.prepare(track, kind);
    for (const old of kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks()) {
      stream.removeTrack(old);
      old.onended = null;
      old.stop();
    }
    stream.addTrack(track);
    for (const listener of this.trackListeners) listener(track);
    const actual = track.getSettings().deviceId ?? deviceId;
    this.update({
      ...(kind === 'video' ? { cameraId: actual } : { microphoneId: actual }),
      revision: this.snapshot.revision + 1,
    });
  }

  /** Stops the camera and mic (leaving the video page). */
  release(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    if (this.watchingDevices) {
      this.devices?.removeEventListener('devicechange', this.onDeviceChange);
      this.watchingDevices = false;
    }
    this.update({ status: 'idle', error: null, revision: this.snapshot.revision + 1 });
  }

  private async doAcquire(): Promise<boolean> {
    // mediaDevices is undefined outside secure contexts (plain http on a LAN IP).
    if (this.devices?.getUserMedia === undefined) {
      this.update({ status: 'error', error: 'insecure' });
      return false;
    }
    this.update({ status: 'requesting', error: null });
    try {
      const stream = await this.devices.getUserMedia({
        video: constraintsFor('video', this.snapshot.cameraId),
        audio: constraintsFor('audio', this.snapshot.microphoneId),
      });
      for (const track of stream.getVideoTracks()) this.prepare(track, 'video');
      for (const track of stream.getAudioTracks()) this.prepare(track, 'audio');
      this.stream = stream;
      if (!this.watchingDevices) {
        this.devices.addEventListener('devicechange', this.onDeviceChange);
        this.watchingDevices = true;
      }
      await this.refreshDevices();
      this.update({
        status: 'ready',
        cameraId: stream.getVideoTracks()[0]?.getSettings().deviceId ?? null,
        microphoneId: stream.getAudioTracks()[0]?.getSettings().deviceId ?? null,
        revision: this.snapshot.revision + 1,
      });
      return true;
    } catch (error) {
      this.update({ status: 'error', error: classifyMediaError(error) });
      return false;
    }
  }

  private prepare(track: MediaStreamTrack, kind: Kind): void {
    track.enabled = kind === 'video' ? this.snapshot.videoEnabled : this.snapshot.audioEnabled;
    // Keep motion smooth rather than sharp when bandwidth is short (maintain-framerate).
    if (kind === 'video') track.contentHint = 'motion';
    track.onended = () => {
      // Device unplugged or revoked: fall back to the system default once.
      this.selectDevice(kind, null).catch(() => {
        this.update({ status: 'error', error: 'no-device' });
      });
    };
  }

  private readonly onDeviceChange = () => {
    void this.refreshDevices();
  };

  private async refreshDevices(): Promise<void> {
    if (this.devices === undefined) return;
    try {
      const all = await this.devices.enumerateDevices();
      const options = (kind: MediaDeviceKind, fallback: string): DeviceOption[] =>
        all
          .filter((device) => device.kind === kind && device.deviceId !== '')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label === '' ? `${fallback} ${String(index + 1)}` : device.label,
          }));
      this.update({
        cameras: options('videoinput', 'Camera'),
        microphones: options('audioinput', 'Microphone'),
      });
    } catch {
      // Device list is a convenience; the stream keeps working without it.
    }
  }

  private update(change: Partial<LocalMediaSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
}
