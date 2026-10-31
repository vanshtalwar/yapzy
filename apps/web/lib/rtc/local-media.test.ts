import { describe, expect, it, vi } from 'vitest';

import { classifyMediaError, LocalMedia } from './local-media.ts';
import { FakeMediaStream, FakeTrack } from './testing.ts';

function deviceIdOf(constraints: boolean | MediaTrackConstraints | undefined): string {
  const id = typeof constraints === 'object' ? constraints.deviceId : undefined;
  return typeof id === 'object' && !Array.isArray(id) && typeof id.exact === 'string'
    ? id.exact
    : 'default';
}

function fakeDevices() {
  const target = new EventTarget();
  const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
    const tracks: FakeTrack[] = [];
    if (constraints.audio !== undefined) {
      tracks.push(new FakeTrack('audio', `mic-${deviceIdOf(constraints.audio)}`));
    }
    if (constraints.video !== undefined) {
      tracks.push(new FakeTrack('video', `cam-${deviceIdOf(constraints.video)}`));
    }
    return Promise.resolve(new FakeMediaStream(tracks));
  });
  const enumerateDevices = vi.fn(() =>
    Promise.resolve([
      { kind: 'videoinput', deviceId: 'cam-default', label: 'FaceTime HD Camera' },
      { kind: 'videoinput', deviceId: 'cam-usb', label: 'USB Camera' },
      { kind: 'audioinput', deviceId: 'mic-default', label: '' },
    ]),
  );
  const devices = Object.assign(target, { getUserMedia, enumerateDevices });
  return { devices: devices as unknown as MediaDevices, getUserMedia };
}

describe('LocalMedia', () => {
  it('asks once for camera + mic and lists the devices', async () => {
    const { devices, getUserMedia } = fakeDevices();
    const media = new LocalMedia(devices);
    const [a, b] = await Promise.all([media.acquire(), media.acquire()]);
    expect([a, b]).toEqual([true, true]);
    expect(await media.acquire()).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]![0]).toMatchObject({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(media.getSnapshot()).toMatchObject({
      status: 'ready',
      cameraId: 'cam-default',
      microphoneId: 'mic-default',
      cameras: [
        { deviceId: 'cam-default', label: 'FaceTime HD Camera' },
        { deviceId: 'cam-usb', label: 'USB Camera' },
      ],
      microphones: [{ deviceId: 'mic-default', label: 'Microphone 1' }],
    });
    const video = media.getStream()!.getVideoTracks()[0]!;
    expect(video.contentHint).toBe('motion');
  });

  it('reports permission, device and insecure-context errors', async () => {
    const { devices, getUserMedia } = fakeDevices();
    getUserMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    const media = new LocalMedia(devices);
    expect(await media.acquire()).toBe(false);
    expect(media.getSnapshot()).toMatchObject({ status: 'error', error: 'denied' });
    expect(classifyMediaError(new DOMException('busy', 'NotReadableError'))).toBe('in-use');
    expect(classifyMediaError(new DOMException('none', 'NotFoundError'))).toBe('no-device');

    const insecure = new LocalMedia({} as MediaDevices);
    expect(await insecure.acquire()).toBe(false);
    expect(insecure.getSnapshot().error).toBe('insecure');
  });

  it('mutes and turns the camera off with track.enabled only', async () => {
    const { devices } = fakeDevices();
    const media = new LocalMedia(devices);
    await media.acquire();
    media.setAudioEnabled(false);
    media.setVideoEnabled(false);
    const stream = media.getStream()!;
    expect(stream.getAudioTracks()[0]!.enabled).toBe(false);
    expect(stream.getVideoTracks()[0]!.enabled).toBe(false);
    expect(media.getSnapshot()).toMatchObject({ audioEnabled: false, videoEnabled: false });
  });

  it('switches a device in place, stops the old track and tells the calls', async () => {
    const { devices } = fakeDevices();
    const media = new LocalMedia(devices);
    await media.acquire();
    media.setVideoEnabled(false);
    const stream = media.getStream()!;
    const old = stream.getVideoTracks()[0]!;
    const replaced = vi.fn();
    media.onTrackReplaced(replaced);
    await media.selectDevice('video', 'usb');
    const fresh = stream.getVideoTracks()[0]!;
    expect(media.getStream()).toBe(stream);
    expect(fresh).not.toBe(old);
    expect((old as unknown as FakeTrack).stopped).toBe(true);
    expect(fresh.enabled).toBe(false); // camera stays off
    expect(replaced).toHaveBeenCalledWith(fresh);
    expect(media.getSnapshot().cameraId).toBe('cam-usb');
    expect(stream.getAudioTracks()).toHaveLength(1);
  });

  it('release stops every track and allows acquiring again', async () => {
    const { devices, getUserMedia } = fakeDevices();
    const media = new LocalMedia(devices);
    await media.acquire();
    const tracks = media.getStream()!.getTracks() as unknown as FakeTrack[];
    media.release();
    expect(tracks.every((track) => track.stopped)).toBe(true);
    expect(media.getSnapshot().status).toBe('idle');
    await media.acquire();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});
