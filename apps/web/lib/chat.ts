'use client';

import { toast } from '@app/ui';
import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';

import { api } from './api.ts';
import { type ChatController, createChatController } from './chat-controller.ts';
import { type ChatState, type ChatStore, createChatStore } from './chat-store.ts';
import { publicConfig } from './config.ts';
import { createCallModeration } from './moderation/call-moderation.ts';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences.ts';
import { createIceServerCache, type IceServerCache } from './rtc/ice-servers.ts';
import { LocalMedia, type LocalMediaSnapshot } from './rtc/local-media.ts';
import { getToken } from './session-token.ts';
import { getSocket } from './socket.ts';

let store: ChatStore | null = null;
let controller: ChatController | null = null;
let disposeTimer: ReturnType<typeof setTimeout> | undefined;
let localMedia: LocalMedia | null = null;
let mediaReleaseTimer: ReturnType<typeof setTimeout> | undefined;
let iceServers: IceServerCache | null = null;

/** The tab's camera + mic, acquired once and shared by every call. */
export function getLocalMedia(): LocalMedia {
  if (mediaReleaseTimer !== undefined) {
    clearTimeout(mediaReleaseTimer); // StrictMode remount: keep the camera on
    mediaReleaseTimer = undefined;
  }
  localMedia ??= new LocalMedia();
  return localMedia;
}

/** Turn the camera off when the video screen unmounts (deferred like the controller). */
export function releaseLocalMedia(): void {
  clearTimeout(mediaReleaseTimer);
  mediaReleaseTimer = setTimeout(() => {
    localMedia?.release();
    mediaReleaseTimer = undefined;
  }, 250);
}

const SERVER_MEDIA: LocalMediaSnapshot = new LocalMedia().getSnapshot();

export function useLocalMedia(): LocalMediaSnapshot {
  const media = getLocalMedia();
  return useSyncExternalStore(media.subscribe, media.getSnapshot, () => SERVER_MEDIA);
}

function getIceServers(): IceServerCache {
  iceServers ??= createIceServerCache({
    fetchCredentials: () => api.getTurnCredentials(getToken() ?? ''),
  });
  return iceServers;
}

/**
 * One chat store per tab. It is created with the defaults, like the server prerender, and the
 * saved preferences are applied right after: zustand serves the initial state during hydration,
 * so the first client render matches the server HTML and React then re-renders with them.
 */
export function getChatStore(): ChatStore {
  if (store === null) {
    store = createChatStore(DEFAULT_PREFERENCES);
    if (typeof window !== 'undefined') {
      store.getState().setPreferences(loadPreferences());
      store.subscribe((state, previous) => {
        if (state.preferences !== previous.preferences) savePreferences(state.preferences);
      });
    }
  }
  return store;
}

/** Browser only: the controller owns the socket. */
export function getChatController(): ChatController {
  if (disposeTimer !== undefined) {
    clearTimeout(disposeTimer); // StrictMode remount: keep the live chat
    disposeTimer = undefined;
  }
  controller ??= createChatController({
    store: getChatStore(),
    socket: getSocket(),
    notify: (message) => {
      toast(message);
    },
    video: {
      localMedia: getLocalMedia(),
      iceServers: getIceServers(),
      forceRelay: publicConfig.forceTurnRelay,
      moderation: {
        create: (options) =>
          createCallModeration(options, {
            uploadFrame: (sessionId, frame) => api.uploadFrame(getToken() ?? '', sessionId, frame),
            nsfw: true,
          }),
      },
    },
    reports: {
      submit: async (fields, frames) => {
        await api.report(getToken() ?? '', fields, frames);
      },
    },
  });
  if (process.env.NEXT_PUBLIC_DEV_HOOKS === 'true') {
    // DEPLOY_ENV=development only: `randomchat.upgradeToSfu()` in the console switches a P2P
    // call to Janus (the gateway accepts it only with NODE_ENV=development).
    const chat = controller;
    Object.assign(window, { randomchat: { upgradeToSfu: () => chat.devUpgradeToSfu() } });
  }
  return controller;
}

/** Leave the chat when the chat screen unmounts — deferred so a StrictMode remount cancels it. */
export function releaseChatController(): void {
  clearTimeout(disposeTimer);
  disposeTimer = setTimeout(() => {
    controller?.dispose();
    controller = null;
    disposeTimer = undefined;
  }, 250);
}

export function useChat<T>(selector: (state: ChatState) => T): T {
  return useStore(getChatStore(), selector);
}
