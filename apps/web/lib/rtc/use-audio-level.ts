'use client';

import { useEffect, useState } from 'react';

import { getLocalMedia } from '../chat.ts';

/** How often the meter re-renders (the analyser itself runs per animation frame). */
const UPDATE_MS = 80;

/**
 * Microphone input level 0–1 from the tab's local stream (Web Audio analyser), for the
 * pre-join check and device settings. `revision` re-attaches after a device switch.
 */
export function useAudioLevel(active: boolean, revision: number): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const track = getLocalMedia().getStream()?.getAudioTracks()[0];
    if (!active || track === undefined || typeof AudioContext === 'undefined') return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    // Chrome starts audio contexts suspended until the page gets a gesture.
    const resume = () => {
      void context.resume();
    };
    resume();
    document.addEventListener('pointerdown', resume, { once: true });

    let frame = 0;
    let lastUpdate = 0;
    let lastValue = -1;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - lastUpdate < UPDATE_MS) return;
      lastUpdate = now;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const value = (sample - 128) / 128;
        sum += value * value;
      }
      // Speech RMS is roughly 0.02–0.25: scale so normal talking fills most of the meter.
      const value = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      if (Math.abs(value - lastValue) >= 0.02) {
        lastValue = value;
        setLevel(value);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', resume);
      source.disconnect();
      void context.close();
    };
  }, [active, revision]);

  return active ? level : 0;
}
