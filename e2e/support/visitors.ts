import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';

export interface Visitor {
  name: string;
  context: BrowserContext;
  page: Page;
}

/**
 * Headless Chrome on macOS hangs while capturing (even fake) audio: keep the fake camera and
 * synthesize the microphone with Web Audio (still a real audio track for WebRTC).
 */
function synthesizedMicrophone(): void {
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream =
      constraints?.video === undefined || constraints.video === false
        ? new MediaStream()
        : await capture({ video: constraints.video });
    if (constraints?.audio !== undefined && constraints.audio !== false) {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      const [track] = destination.stream.getAudioTracks();
      if (track !== undefined) stream.addTrack(track);
    }
    return stream;
  };
}

export async function newVisitor(browser: Browser, name: string): Promise<Visitor> {
  const context = await browser.newContext({ locale: 'en-US' });
  await context.addInitScript(synthesizedMicrophone);
  return { name, context, page: await context.newPage() };
}

/** Age gate: the three consents, then Turnstile (Cloudflare's always-pass test key). */
async function passAgeGate(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  for (const name of ['I am 18 or older', /Terms of Service/, /Privacy Policy/]) {
    const box = dialog.getByRole('checkbox', { name });
    if ((await box.getAttribute('aria-checked')) !== 'true') await box.click();
  }
  await expect(dialog.getByRole('button', { name: 'Start chatting' })).toBeEnabled({
    timeout: 30_000,
  });
  await dialog.getByRole('button', { name: 'Start chatting' }).click();
}

export async function startText(visitor: Visitor): Promise<void> {
  const { page } = visitor;
  await page.goto('/');
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await passAgeGate(page);
  await page.waitForURL(/\/chat/);
}

export async function startVideo(visitor: Visitor): Promise<void> {
  const { page } = visitor;
  await page.goto('/chat?mode=video');
  const start = page.getByRole('button', { name: 'Start video chat' });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();
  if (
    await page
      .getByRole('dialog')
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
  ) {
    await passAgeGate(page);
  }
}

export const chatLog = (page: Page) => page.getByRole('log', { name: 'Chat messages' });

export async function expectInChat(visitor: Visitor, text: string, timeout?: number) {
  await expect(chatLog(visitor.page).getByText(text).first()).toBeVisible(
    timeout === undefined ? {} : { timeout },
  );
}

export async function send(visitor: Visitor, text: string): Promise<void> {
  const box = visitor.page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

export const visitorIdOf = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (JSON.parse(sessionStorage.getItem('rc.session') ?? '{}') as { visitorId?: string })
        .visitorId ?? '',
  );

/** The stranger's video element and how far its playback has got. */
export const remoteVideo = (page: Page) => page.locator('video[aria-label="Stranger’s camera"]');

export const remoteVideoState = (page: Page) =>
  remoteVideo(page).evaluate((video: HTMLVideoElement) => ({
    width: video.videoWidth,
    time: video.currentTime,
    playing: !video.paused && video.readyState >= 2,
  }));

/** Connected per `data-rtc-state` and actually rendering remote frames (`ontrack` fired). */
export async function expectVideoConnected(visitor: Visitor): Promise<void> {
  await expect(visitor.page.locator('[data-rtc-state]').first()).toHaveAttribute(
    'data-rtc-state',
    'connected',
    { timeout: 30_000 },
  );
  await expect
    .poll(async () => (await remoteVideoState(visitor.page)).width, { timeout: 20_000 })
    .toBeGreaterThan(0);
}
