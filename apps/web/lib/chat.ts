'use client';

import { toast } from '@app/ui';
import { useStore } from 'zustand';

import { type ChatController, createChatController } from './chat-controller.ts';
import { type ChatState, type ChatStore, createChatStore } from './chat-store.ts';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences.ts';
import { getSocket } from './socket.ts';

let store: ChatStore | null = null;
let controller: ChatController | null = null;
let disposeTimer: ReturnType<typeof setTimeout> | undefined;

/** One chat store per tab. On the server (prerender) it only holds defaults. */
export function getChatStore(): ChatStore {
  if (store === null) {
    const browser = typeof window !== 'undefined';
    store = createChatStore(browser ? loadPreferences() : DEFAULT_PREFERENCES);
    if (browser) {
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
  });
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
