/**
 * JPEG stills from the video track of a stream, via a hidden <video> and a canvas — used for
 * moderation frames (own camera), report evidence and the client NSFW check (stranger).
 * Media objects stay here, never in React state.
 */
export interface FrameGrabber {
  /** The hidden element showing the current track (null without a live video track). */
  element(): HTMLVideoElement | null;
  grab(options: { maxSize: number; quality: number }): Promise<Blob | null>;
  stop(): void;
}

export function createFrameGrabber(getStream: () => MediaStream | null): FrameGrabber {
  let video: HTMLVideoElement | null = null;
  let bound: MediaStreamTrack | null = null;

  function element(): HTMLVideoElement | null {
    const track = getStream()?.getVideoTracks()[0] ?? null;
    if (track?.readyState !== 'live') return null;
    if (video === null) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
    }
    if (bound !== track) {
      bound = track;
      video.srcObject = new MediaStream([track]);
      video.play().catch(() => undefined);
    }
    return video;
  }

  return {
    element,

    async grab({ maxSize, quality }) {
      const source = element();
      if (source === null || source.videoWidth === 0 || source.videoHeight === 0) return null;
      const scale = Math.min(1, maxSize / Math.max(source.videoWidth, source.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(source.videoWidth * scale);
      canvas.height = Math.round(source.videoHeight * scale);
      canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
      return new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', quality);
      });
    },

    stop() {
      if (video !== null) video.srcObject = null;
      video = null;
      bound = null;
    },
  };
}
