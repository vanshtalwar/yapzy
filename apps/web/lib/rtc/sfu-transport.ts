import { type PeerRole, type SfuJoin } from '@app/shared';
import { z } from 'zod';

import {
  JanusClient,
  type JanusClientOptions,
  JanusError,
  type JanusHandle,
  type Jsep,
} from './janus-client.ts';
import { type CandidateType, deltaOf, qualityOf, readStats, type StatsSample } from './stats.ts';
import {
  type CallTransport,
  type PeerState,
  type PeerSummary,
  type Quality,
  type RemoteParticipantView,
  type RtcSignal,
} from './types.ts';

const VIDEOROOM = 'janus.plugin.videoroom';

/**
 * Three simulcast layers (rids h/m/l, as janus.js sends them). Janus forwards one layer per
 * subscriber, so a small tile can take the low one. Chrome drops layers the camera resolution
 * can't fill; Janus then forwards the best one available.
 */
const SIMULCAST_ENCODINGS: RTCRtpEncodingParameters[] = [
  { rid: 'h', active: true, maxBitrate: 450_000 },
  { rid: 'm', active: true, maxBitrate: 150_000, scaleResolutionDownBy: 2 },
  { rid: 'l', active: true, maxBitrate: 50_000, scaleResolutionDownBy: 4 },
];
/** Janus substream index per tile size (0 = lowest layer). */
const SUBSTREAM = { high: 2, low: 0 } as const;

export type VideoQualityLevel = keyof typeof SUBSTREAM;

const publisherSchema = z.object({ id: z.number(), display: z.string().optional() });
const streamSchema = z.object({
  mid: z.string(),
  type: z.string(),
  feed_id: z.number().optional(),
  feed_display: z.string().optional(),
  active: z.boolean().optional(),
});
const joinedSchema = z.object({
  videoroom: z.literal('joined'),
  id: z.number(),
  private_id: z.number(),
  publishers: z.array(publisherSchema).default([]),
});

export interface SfuTransportOptions {
  sessionId: string;
  selfParticipantId: string;
  /** Room, node URL and this participant's token (Janus API + the room's allowed list). */
  join: SfuJoin;
  /** Shared by every transport of the call; never stopped here. */
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  forceRelay: boolean;
  /** A fresh API token (`call:sfuToken`); null if the gateway refused (room changed). */
  refreshToken: () => Promise<string | null>;
  onChange: () => void;
  /** Media of every expected participant arrives through Janus (make-before-break swap). */
  onReady: () => void;
  /** Janus can't be reached even after reconnecting/rejoining (the gateway may fail over). */
  onFailed: () => void;
  onError?: (message: string, error: unknown) => void;
  createClient?: (options: JanusClientOptions) => JanusClient;
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  createMediaStream?: () => MediaStream;
  now?: () => number;
  statsIntervalMs?: number;
  /** Give up reconnecting after this long. */
  reconnectWindowMs?: number;
}

interface Feed {
  participantId: string;
}

/**
 * Janus VideoRoom transport (Part 11): one publisher PeerConnection (camera + mic, simulcast)
 * and one multistream subscriber PeerConnection receiving every other participant's feed.
 * Feeds are mapped to participants by `display` (= participantId); feeds of anyone who isn't
 * a current participant of the session are ignored. Follows the Part 7 lifecycle rules:
 * handlers attached right after constructing a connection, media objects never leave this
 * class, every createOffer/createAnswer is paired with setLocalDescription.
 */
export class SfuTransport implements CallTransport {
  readonly topology = 'sfu' as const;
  readonly epoch: number;

  private readonly opts: SfuTransportOptions;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly expected = new Set<string>();
  /** Janus publisher id → feed (only publishers whose display is a participantId). */
  private readonly feeds = new Map<number, Feed>();
  private readonly subscribed = new Set<number>();
  /** Subscriber m-line mid → participantId. */
  private readonly midOwner = new Map<string, string>();
  private readonly midFeed = new Map<string, number>();
  private readonly remote = new Map<string, MediaStream>();
  private readonly levels = new Map<string, VideoQualityLevel>();
  private readonly speaking = new Set<string>();

  private apiToken: string;
  private client: JanusClient | null = null;
  private publisher: {
    handle: JanusHandle;
    pc: RTCPeerConnection | null;
    privateId: number;
  } | null = null;
  private subscriber: { handle: JanusHandle; pc: RTCPeerConnection } | null = null;
  /** Subscription changes and renegotiations, one at a time (Janus wants each offer answered). */
  private queue: Promise<void> = Promise.resolve();
  private iceServers: RTCIceServer[];
  private state: PeerState = 'connecting';
  private quality: Quality | null = null;
  private ready = false;
  private closed = false;
  private reconnecting = false;
  private connectedAt: number | null = null;
  private lastSample: StatsSample | null = null;
  private candidates: { local: CandidateType; remote: CandidateType } = {
    local: 'unknown',
    remote: 'unknown',
  };
  private readonly rtt = { sum: 0, count: 0 };
  private readonly bitrate = { sum: 0, count: 0 };
  private readonly statsTimer: ReturnType<typeof setInterval>;
  private tokenTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: SfuTransportOptions) {
    this.opts = opts;
    this.epoch = opts.join.epoch;
    this.now = opts.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.apiToken = opts.join.token;
    this.iceServers = opts.iceServers;
    this.statsTimer = setInterval(() => {
      void this.collectStats();
    }, opts.statsIntervalMs ?? 2_000);
    this.scheduleTokenRefresh();
    void this.start().catch((error: unknown) => {
      this.report('joining the media server failed', error);
      void this.reconnect();
    });
  }

  // --- CallTransport ------------------------------------------------------------------------

  addPeer(peer: PeerRole): void {
    if (this.closed || this.expected.has(peer.participantId)) return;
    this.expected.add(peer.participantId);
    this.streamOf(peer.participantId);
    this.ready = false; // the newcomer's media must arrive too (Part 12 joiners)
    this.enqueue(() => this.syncSubscriptions());
    this.opts.onChange();
  }

  removePeer(participantId: string): PeerSummary | null {
    if (!this.expected.delete(participantId)) return null;
    const stream = this.remote.get(participantId);
    for (const track of stream?.getTracks() ?? []) stream?.removeTrack(track);
    this.remote.delete(participantId);
    this.speaking.delete(participantId);
    this.enqueue(() => this.syncSubscriptions());
    this.checkReady();
    this.opts.onChange();
    return this.summaryFor(participantId);
  }

  handleSignal(_signal: RtcSignal): void {
    // P2P signals don't apply: everything goes through Janus.
  }

  remoteStream(participantId: string): MediaStream | null {
    return this.closed ? null : (this.remote.get(participantId) ?? null);
  }

  participants(): RemoteParticipantView[] {
    return [...this.expected].map((participantId) => {
      const tracks = this.remote.get(participantId)?.getTracks() ?? [];
      const live = tracks.some((track) => track.kind === 'video' && !track.muted);
      return {
        participantId,
        state: this.state === 'connected' && !live ? 'connecting' : this.state,
        quality: this.quality,
        trackCount: tracks.length,
        speaking: this.speaking.has(participantId),
      };
    });
  }

  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.publisher?.pc
      ?.getSenders()
      .find((candidate) => candidate.track?.kind === track.kind);
    await sender?.replaceTrack(track);
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers;
    for (const pc of [this.publisher?.pc, this.subscriber?.pc]) {
      pc?.setConfiguration({ ...pc.getConfiguration(), iceServers });
    }
  }

  recover(): void {
    if (this.closed) return;
    if (this.client?.connected !== true) void this.reconnect();
  }

  /**
   * Which simulcast layer to receive for a participant: `high` for a large tile, `low` for a
   * small one (Part 12 grid). Applied right away if subscribed, else on subscription.
   */
  setVideoQuality(participantId: string, level: VideoQualityLevel): void {
    if (this.levels.get(participantId) === level) return;
    this.levels.set(participantId, level);
    this.enqueue(() => this.applyLevels([participantId]));
  }

  close(): PeerSummary[] {
    if (this.closed) return [];
    const summaries = [...this.expected].map((participantId) => this.summaryFor(participantId));
    this.closed = true;
    this.state = 'closed';
    clearInterval(this.statsTimer);
    clearTimeout(this.tokenTimer);
    this.teardownConnections();
    this.client?.destroy();
    this.client = null;
    for (const stream of this.remote.values()) {
      for (const track of stream.getTracks()) stream.removeTrack(track);
    }
    this.remote.clear();
    return summaries;
  }

  /** Every expected participant's media arrives through Janus. */
  get isReady(): boolean {
    return this.ready;
  }

  // --- joining ------------------------------------------------------------------------------

  private async start(): Promise<void> {
    const create =
      this.opts.createClient ?? ((options: JanusClientOptions) => new JanusClient(options));
    const client = create({ url: this.opts.join.wsUrl, token: () => this.apiToken });
    this.client = client;
    client.onClose = () => {
      void this.reconnect();
    };
    client.onSessionLost = () => {
      void this.reconnect({ rejoin: true });
    };
    await client.connect();
    if (this.closed) return;
    await client.createSession();
    await this.joinAsPublisher(client);
  }

  private async joinAsPublisher(client: JanusClient): Promise<void> {
    const handle = await client.attach(VIDEOROOM, {
      onEvent: (data) => {
        this.onPublisherEvent(data);
      },
      onHangup: () => {
        if (!this.closed) void this.reconnect({ rejoin: true });
      },
    });
    if (this.closed) return;
    const reply = await handle.message({
      request: 'join',
      ptype: 'publisher',
      room: this.opts.join.roomId,
      display: this.opts.selfParticipantId,
      token: this.opts.join.token,
    });
    const joined = joinedSchema.parse(reply.data);
    this.publisher = { handle, pc: null, privateId: joined.private_id };
    this.onPublishers(joined.publishers);
    await this.publish(handle);
  }

  /** The publisher connection: send-only camera + mic, video in three simulcast layers. */
  private async publish(handle: JanusHandle): Promise<void> {
    const pc = this.createConnection();
    // Handlers before any transceiver or description (Part 7 rules).
    pc.onicecandidate = (event) => {
      handle.trickle(event.candidate === null ? null : event.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      this.onConnectionState();
    };
    if (this.publisher !== null) this.publisher.pc = pc;
    const stream = this.opts.localStream;
    for (const track of stream.getTracks()) {
      pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        ...(track.kind === 'video' ? { sendEncodings: SIMULCAST_ENCODINGS } : {}),
      });
    }
    await pc.setLocalDescription(); // creates the offer and applies it
    const offer = pc.localDescription;
    if (offer === null || this.closed) return;
    const reply = await handle.message({ request: 'publish' }, { type: 'offer', sdp: offer.sdp });
    if (reply.jsep?.type === 'answer' && !this.isClosed())
      await pc.setRemoteDescription(reply.jsep);
  }

  private onPublisherEvent(data: Record<string, unknown>): void {
    if (this.closed) return;
    const kind = data.videoroom;
    if (kind === 'talking' || kind === 'stopped-talking') {
      const participantId = this.feeds.get(Number(data.id))?.participantId;
      if (participantId === undefined) return;
      if (kind === 'talking') this.speaking.add(participantId);
      else this.speaking.delete(participantId);
      this.opts.onChange();
      return;
    }
    if (kind === 'destroyed' || (data.leaving === 'ok' && data.reason === 'kicked')) {
      // Room gone or we were removed: the gateway sends what's next (failover or the end).
      this.setState('reconnecting');
      return;
    }
    const publishers = z.array(publisherSchema).safeParse(data.publishers);
    if (publishers.success) this.onPublishers(publishers.data);
    for (const key of ['unpublished', 'leaving'] as const) {
      const id = data[key];
      if (typeof id === 'number') this.onFeedGone(id);
    }
  }

  /** New publishers: keep only participants of this session (by display), then subscribe. */
  private onPublishers(list: z.output<typeof publisherSchema>[]): void {
    let changed = false;
    for (const { id, display } of list) {
      if (display === undefined || display === this.opts.selfParticipantId) continue;
      if (this.feeds.get(id)?.participantId === display) continue;
      this.feeds.set(id, { participantId: display });
      changed = true;
    }
    if (changed) this.enqueue(() => this.syncSubscriptions());
  }

  private onFeedGone(feedId: number): void {
    this.feeds.delete(feedId);
    this.subscribed.delete(feedId);
    // Janus updates the subscription itself (an `updated` offer) when a feed goes away.
  }

  // --- subscriptions ------------------------------------------------------------------------

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      if (!this.closed) this.report('updating the subscription failed', error);
    });
  }

  /** Subscribe to wanted feeds (expected participants), unsubscribe from the rest. */
  private async syncSubscriptions(): Promise<void> {
    if (this.closed || this.publisher === null || this.client === null) return;
    const wanted = [...this.feeds]
      .filter(([id, feed]) => this.expected.has(feed.participantId) && !this.subscribed.has(id))
      .map(([id]) => id);
    const unwanted = [...this.subscribed].filter((id) => {
      const feed = this.feeds.get(id);
      return feed === undefined || !this.expected.has(feed.participantId);
    });
    if (this.subscriber === null) {
      if (wanted.length > 0) await this.createSubscriber(this.client, wanted);
      return;
    }
    if (wanted.length > 0) {
      for (const id of wanted) this.subscribed.add(id);
      const reply = await this.subscriber.handle.message({
        request: 'subscribe',
        streams: wanted.map((feed) => ({ feed })),
      });
      await this.onSubscriberUpdate(reply.data, reply.jsep);
    }
    if (unwanted.length > 0) {
      for (const id of unwanted) this.subscribed.delete(id);
      const reply = await this.subscriber.handle.message({
        request: 'unsubscribe',
        streams: unwanted.map((feed) => ({ feed })),
      });
      await this.onSubscriberUpdate(reply.data, reply.jsep);
    }
  }

  /** The multistream subscriber: `join` (with our publisher's private id) → offer → answer. */
  private async createSubscriber(client: JanusClient, feeds: number[]): Promise<void> {
    const handle = await client.attach(VIDEOROOM, {
      onEvent: (data, jsep) => {
        // Unsolicited `updated` offers: a feed we watch went away (Janus auto-updates).
        this.enqueue(() => this.onSubscriberUpdate(data, jsep));
      },
    });
    const pc = this.createConnection();
    pc.ontrack = (event) => {
      this.onTrack(event);
    };
    pc.onicecandidate = (event) => {
      handle.trickle(event.candidate === null ? null : event.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      this.onConnectionState();
    };
    this.subscriber = { handle, pc };
    for (const id of feeds) this.subscribed.add(id);
    const reply = await handle.message({
      request: 'join',
      ptype: 'subscriber',
      room: this.opts.join.roomId,
      private_id: this.publisher?.privateId,
      streams: feeds.map((feed) => ({ feed })),
      token: this.opts.join.token,
    });
    await this.onSubscriberUpdate(reply.data, reply.jsep);
  }

  /** `attached` / `updated`: remember which mid carries whom, answer the offer with `start`. */
  private async onSubscriberUpdate(
    data: Record<string, unknown>,
    jsep: Jsep | undefined,
  ): Promise<void> {
    const subscriber = this.subscriber;
    if (this.closed || subscriber === null) return;
    const streams = z.array(streamSchema).safeParse(data.streams);
    if (streams.success) {
      this.midOwner.clear();
      this.midFeed.clear();
      for (const stream of streams.data) {
        const owner = stream.feed_display;
        if (owner === undefined || stream.feed_id === undefined || stream.active === false)
          continue;
        this.midOwner.set(stream.mid, owner);
        this.midFeed.set(stream.mid, stream.feed_id);
      }
      this.dropOrphanTracks();
    }
    if (jsep?.type !== 'offer') return;
    await subscriber.pc.setRemoteDescription(jsep);
    if (this.isClosed()) return;
    await subscriber.pc.setLocalDescription(); // creates the answer and applies it
    const answer = subscriber.pc.localDescription;
    if (answer === null || this.isClosed()) return;
    await subscriber.handle.message({ request: 'start' }, { type: 'answer', sdp: answer.sdp });
    await this.applyLevels([...this.expected]);
  }

  /** Simulcast layer per participant (`configure` on the subscriber, per video mid). */
  private async applyLevels(participantIds: string[]): Promise<void> {
    const subscriber = this.subscriber;
    if (this.closed || subscriber === null) return;
    const streams = [...this.midOwner]
      .filter(([mid, owner]) => participantIds.includes(owner) && this.isVideoMid(mid))
      .map(([mid, owner]) => ({ mid, substream: SUBSTREAM[this.levels.get(owner) ?? 'high'] }));
    if (streams.length === 0) return;
    await subscriber.handle.message({ request: 'configure', streams });
  }

  private isVideoMid(mid: string): boolean {
    return (
      this.subscriber?.pc
        .getTransceivers()
        .some(
          (transceiver) => transceiver.mid === mid && transceiver.receiver.track.kind === 'video',
        ) ?? false
    );
  }

  private onTrack({ track, transceiver }: RTCTrackEvent): void {
    if (this.closed) return;
    const owner = transceiver.mid === null ? undefined : this.midOwner.get(transceiver.mid);
    if (owner === undefined || !this.expected.has(owner)) return; // not a current participant
    const stream = this.streamOf(owner);
    for (const old of stream.getTracks()) {
      if (old.kind === track.kind && old !== track) stream.removeTrack(old);
    }
    if (!stream.getTracks().includes(track)) stream.addTrack(track);
    track.addEventListener('unmute', () => {
      this.checkReady();
      this.opts.onChange();
    });
    track.addEventListener('mute', () => {
      this.opts.onChange();
    });
    this.checkReady();
    this.opts.onChange();
  }

  /** Tracks of m-lines Janus no longer maps to that participant are removed. */
  private dropOrphanTracks(): void {
    const subscriber = this.subscriber;
    if (subscriber === null) return;
    const liveTracks = new Map<string, MediaStreamTrack[]>();
    for (const transceiver of subscriber.pc.getTransceivers()) {
      const owner = transceiver.mid === null ? undefined : this.midOwner.get(transceiver.mid);
      if (owner === undefined) continue;
      liveTracks.set(owner, [...(liveTracks.get(owner) ?? []), transceiver.receiver.track]);
    }
    for (const [participantId, stream] of this.remote) {
      const keep = liveTracks.get(participantId) ?? [];
      for (const track of stream.getTracks()) {
        if (!keep.includes(track)) stream.removeTrack(track);
      }
    }
  }

  private streamOf(participantId: string): MediaStream {
    let stream = this.remote.get(participantId);
    if (stream === undefined) {
      stream = (this.opts.createMediaStream ?? (() => new MediaStream()))();
      this.remote.set(participantId, stream);
    }
    return stream;
  }

  /** Ready = the subscriber is connected and video from every expected participant flows. */
  private checkReady(): void {
    if (this.ready || this.closed || this.expected.size === 0) return;
    if (this.subscriber?.pc.connectionState !== 'connected') return;
    const everyone = [...this.expected].every((participantId) =>
      (this.remote.get(participantId)?.getTracks() ?? []).some(
        (track) => track.kind === 'video' && !track.muted,
      ),
    );
    if (!everyone) return;
    this.ready = true;
    this.opts.onReady();
  }

  // --- connection state, reconnects ------------------------------------------------------------

  private createConnection(): RTCPeerConnection {
    const create =
      this.opts.createPeerConnection ??
      ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
    return create({
      iceServers: this.iceServers,
      iceTransportPolicy: this.opts.forceRelay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    });
  }

  private onConnectionState(): void {
    if (this.closed) return;
    const states = [this.publisher?.pc?.connectionState, this.subscriber?.pc.connectionState];
    if (states.includes('failed')) {
      void this.reconnect({ rejoin: true });
      return;
    }
    if (states.includes('disconnected')) {
      this.setState('reconnecting');
      return;
    }
    const subscriberUp =
      this.subscriber === null || this.subscriber.pc.connectionState === 'connected';
    if (this.publisher?.pc?.connectionState === 'connected' && subscriberUp) {
      this.connectedAt ??= this.now();
      this.setState('connected');
      this.checkReady();
    }
  }

  /**
   * The Janus WebSocket dropped: reconnect and `claim` the session (PeerConnections keep
   * running meanwhile). If Janus no longer has it (or `rejoin`), join the room again with the
   * same token. After `reconnectWindowMs` without success: `onFailed` (the gateway moves the
   * call if the node died).
   */
  private async reconnect({ rejoin = false }: { rejoin?: boolean } = {}): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.setState('reconnecting');
    const deadline = this.now() + (this.opts.reconnectWindowMs ?? 15_000);
    let delay = 250;
    try {
      while (!this.isClosed() && this.now() < deadline) {
        try {
          if (!rejoin && this.client !== null) {
            this.client.dropConnection();
            await this.client.connect();
            if (await this.client.claim()) {
              this.onConnectionState();
              return;
            }
          }
          await this.rejoin();
          return;
        } catch (error) {
          if (error instanceof JanusError && error.code === 403) await this.refreshToken();
          rejoin = true;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 2_000);
      }
      if (!this.isClosed()) {
        this.setState('failed');
        this.opts.onFailed();
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** A fresh Janus session in the same room: new connections, same allowed-list token. */
  private async rejoin(): Promise<void> {
    this.teardownConnections();
    this.client?.destroy();
    this.client = null;
    this.ready = false;
    if (this.tokenExpiresInMs() < 60_000) await this.refreshToken();
    await this.start();
  }

  private teardownConnections(): void {
    for (const pc of [this.publisher?.pc, this.subscriber?.pc]) {
      if (pc === null || pc === undefined) continue;
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    this.publisher = null;
    this.subscriber = null;
    this.subscribed.clear();
    this.feeds.clear();
    this.midOwner.clear();
    this.midFeed.clear();
    this.queue = Promise.resolve();
  }

  private setState(state: PeerState): void {
    if (this.state === state || this.closed) return;
    this.state = state;
    this.opts.onChange();
  }

  // --- tokens ---------------------------------------------------------------------------------

  /** Seconds since epoch in the token's first field ("<expiry>,janus,…"). */
  private tokenExpiresInMs(): number {
    const expiry = Number(this.apiToken.split(',')[0]);
    return Number.isFinite(expiry) ? expiry * 1_000 - Date.now() : 0;
  }

  /** Janus checks the token on every request: replace it well before it expires. */
  private scheduleTokenRefresh(): void {
    clearTimeout(this.tokenTimer);
    if (this.closed) return;
    const inMs = Math.max(5_000, this.tokenExpiresInMs() - 120_000);
    this.tokenTimer = setTimeout(() => {
      void this.refreshToken().finally(() => {
        this.scheduleTokenRefresh();
      });
    }, inMs);
  }

  private async refreshToken(): Promise<void> {
    try {
      const token = await this.opts.refreshToken();
      if (token !== null) this.apiToken = token;
    } catch (error) {
      this.report('refreshing the media server token failed', error);
    }
  }

  // --- stats ------------------------------------------------------------------------------------

  private async collectStats(): Promise<void> {
    const pc = this.subscriber?.pc;
    if (this.closed || pc === undefined) return;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    if (this.isClosed()) return;
    const sample = readStats(report, this.now());
    const delta = deltaOf(this.lastSample, sample);
    this.lastSample = sample;
    if (sample.localCandidateType !== 'unknown') {
      this.candidates = { local: sample.localCandidateType, remote: sample.remoteCandidateType };
    }
    if (this.state !== 'connected') return;
    if (delta.rttMs !== null) {
      this.rtt.sum += delta.rttMs;
      this.rtt.count += 1;
    }
    if (delta.receiveKbps !== null) {
      this.bitrate.sum += delta.receiveKbps;
      this.bitrate.count += 1;
    }
    const quality = qualityOf(delta);
    if (quality !== this.quality) {
      this.quality = quality;
      this.opts.onChange();
    }
  }

  /** One summary per remote participant (they share the subscriber connection's numbers). */
  private summaryFor(participantId: string): PeerSummary {
    const average = ({ sum, count }: { sum: number; count: number }, max: number) =>
      count === 0 ? null : Math.min(max, Math.round(sum / count));
    return {
      peer: participantId,
      localCandidateType: this.candidates.local,
      remoteCandidateType: this.candidates.remote,
      avgRttMs: average(this.rtt, 60_000),
      avgBitrateKbps: average(this.bitrate, 100_000),
      timeToConnectedMs:
        this.connectedAt === null
          ? null
          : Math.min(600_000, Math.round(this.connectedAt - this.startedAt)),
      failed: this.state === 'failed',
    };
  }

  /** Re-read after an await: `close()` may have run meanwhile. */
  private isClosed(): boolean {
    return this.closed;
  }

  private report(message: string, error: unknown): void {
    this.opts.onError?.(message, error);
  }
}
