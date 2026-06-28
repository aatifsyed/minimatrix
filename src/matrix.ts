// A thin, opinionated wrapper around matrix-js-sdk.
//
// The UI never touches the SDK directly: this module turns raw Matrix events
// into a small, flat `Message` shape and exposes only the four things the app
// can do — read the timeline, load older history, send an emoji, send a voice
// note.

import {
  createClient,
  ClientEvent,
  RoomEvent,
  SyncState,
  type MatrixClient as SdkClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import type { Config } from "./config";
import {
  isUsableRoom,
  NO_ROOM_ERROR,
  pickDefaultRoom,
  REQUESTED_ROOM_ERROR,
  type RoomPick,
} from "./rooms";
import { clearSession, loadSession, saveSession, type Session } from "./session";

export type MessageKind = "text" | "emoji" | "image" | "audio" | "video" | "file" | "unknown";

export interface Message {
  id: string;
  sender: string;
  senderName: string;
  ts: number;
  kind: MessageKind;
  body: string;
  mxc?: string;
  mimetype?: string;
  duration?: number;
  width?: number;
  height?: number;
  isVoice: boolean;
  mine: boolean;
}

export type Status = "connecting" | "online" | "offline";

const TIMELINE_LIMIT = 30;

// Object URLs we mint for media. Bounded so a long browsing session doesn't grow
// the blob set without limit; the least-recently-used URL is revoked on overflow.
const MEDIA_CACHE_LIMIT = 64;

export class Matrix {
  onMessage?: (message: Message, live: boolean) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onStatus?: (status: Status) => void;

  roomId = "";
  roomName = "";

  private config: Config;
  private client!: SdkClient;
  private ready = false;
  private readonly rendered = new Set<string>();
  private readonly mediaCache = new Map<string, string>();
  private readonly mediaInflight = new Map<string, Promise<string>>();

  constructor(config: Config) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.onStatus?.("connecting");
    const baseUrl = this.config.homeserver;
    const session = await this.resolveSession(baseUrl);

    this.client = createClient({
      baseUrl,
      accessToken: session.accessToken,
      userId: session.userId,
      deviceId: session.deviceId,
    });

    this.bindEvents();
    await this.client.startClient({ initialSyncLimit: TIMELINE_LIMIT });
  }

  // Reuse a stored token while it still works; otherwise log in fresh. This keeps
  // each install pinned to one device rather than minting a new one per launch.
  private async resolveSession(baseUrl: string): Promise<Session> {
    const saved = loadSession(baseUrl, this.config.user);
    if (saved && (await this.tokenStillValid(baseUrl, saved.accessToken))) return saved;
    if (saved) clearSession(baseUrl, this.config.user);
    return this.login(baseUrl);
  }

  private async login(baseUrl: string): Promise<Session> {
    const login = createClient({ baseUrl });
    const result = await login.loginWithPassword(this.config.user, this.config.password);
    const session: Session = {
      accessToken: result.access_token,
      deviceId: result.device_id,
      userId: result.user_id,
    };
    saveSession(baseUrl, this.config.user, session);
    return session;
  }

  // Cheap auth check before we commit to a full sync: a revoked or expired token
  // (device pruned, password changed elsewhere) returns 401 here and we re-login.
  private async tokenStillValid(baseUrl: string, accessToken: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.client?.stopClient();
    for (const url of this.mediaCache.values()) URL.revokeObjectURL(url);
    this.mediaCache.clear();
    this.mediaInflight.clear();
  }

  // --- sending -------------------------------------------------------------

  async sendEmoji(emoji: string): Promise<void> {
    await this.client.sendTextMessage(this.roomId, emoji);
  }

  async sendVoice(blob: Blob, durationMs: number): Promise<void> {
    const upload = await this.client.uploadContent(blob, {
      name: "voice-message",
      type: blob.type || "audio/ogg",
      includeFilename: false,
    });

    const content = {
      msgtype: "m.audio",
      body: "Voice message",
      url: upload.content_uri,
      info: { mimetype: blob.type, size: blob.size, duration: durationMs },
      // Markers that let full clients (e.g. Element) show this as a proper
      // voice note rather than a generic audio attachment.
      "org.matrix.msc1767.audio": { duration: durationMs },
      "org.matrix.msc3245.voice": {},
    };
    await this.client.sendEvent(this.roomId, "m.room.message" as never, content as never);
  }

  // --- history -------------------------------------------------------------

  async loadOlder(): Promise<Message[]> {
    const room = this.client?.getRoom(this.roomId);
    if (!room) return [];

    const sizeBefore = room.getLiveTimeline().getEvents().length;
    await this.client.scrollback(room, TIMELINE_LIMIT);
    const events = room.getLiveTimeline().getEvents();
    const added = events.length - sizeBefore;
    if (added <= 0) return [];

    // Backward pagination prepends to the live timeline, so the freshly fetched
    // events are exactly the leading `added`. Walk only those (not the whole
    // timeline) and return them oldest-first, ready to prepend in order.
    const older: Message[] = [];
    for (const event of events.slice(0, added)) {
      const message = this.consume(event);
      if (message) older.push(message);
    }
    return older;
  }

  // --- media ---------------------------------------------------------------

  // Modern homeservers (Continuwuity included) gate media behind an
  // authenticated endpoint, so a bare URL in an <img>/<audio> tag won't load.
  // We fetch with the access token and hand back a local object URL instead.
  async mediaUrl(mxc: string): Promise<string> {
    const cached = this.mediaCache.get(mxc);
    if (cached) {
      // Touch to mark most-recently-used (Map keeps insertion order).
      this.mediaCache.delete(mxc);
      this.mediaCache.set(mxc, cached);
      return cached;
    }

    // Coalesce concurrent requests for the same media (e.g. the same photo in
    // both history and a live echo) so we fetch and mint one object URL.
    let inflight = this.mediaInflight.get(mxc);
    if (!inflight) {
      inflight = this.fetchMedia(mxc)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          this.mediaCache.set(mxc, url);
          this.evictMedia();
          return url;
        })
        .finally(() => this.mediaInflight.delete(mxc));
      this.mediaInflight.set(mxc, inflight);
    }
    return inflight;
  }

  private evictMedia(): void {
    while (this.mediaCache.size > MEDIA_CACHE_LIMIT) {
      const oldest = this.mediaCache.keys().next().value;
      if (oldest === undefined) break;
      const url = this.mediaCache.get(oldest);
      if (url) URL.revokeObjectURL(url);
      this.mediaCache.delete(oldest);
    }
  }

  private async fetchMedia(mxc: string): Promise<Blob> {
    const token = this.client.getAccessToken();
    const authed = this.client.mxcUrlToHttp(
      mxc,
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    );
    if (authed) {
      const res = await fetch(authed, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return res.blob();
    }
    // Fall back to legacy unauthenticated media for older homeservers.
    const legacy = this.client.mxcUrlToHttp(
      mxc,
      undefined,
      undefined,
      undefined,
      false,
      false,
      false,
    );
    if (legacy) {
      const res = await fetch(legacy);
      if (res.ok) return res.blob();
    }
    throw new Error(`Could not load media (${mxc})`);
  }

  // --- internals -----------------------------------------------------------

  private bindEvents(): void {
    this.client.on(ClientEvent.Sync, (state) => {
      if (state === SyncState.Prepared) void this.onPrepared();
      else if (state === SyncState.Syncing) this.onStatus?.("online");
      else if (state === SyncState.Error) this.onStatus?.("offline");
    });

    this.client.on(RoomEvent.Timeline, (event, _room, toStartOfTimeline, removed, data) => {
      if (toStartOfTimeline || removed) return;
      if (!this.ready || event.getRoomId() !== this.roomId) return;
      const message = this.consume(event);
      if (message) this.onMessage?.(message, Boolean(data?.liveEvent));
    });
  }

  private async onPrepared(): Promise<void> {
    if (this.ready) return; // PREPARED fires once, but guard against re-entry.

    const pick = this.pickRoom();
    if (pick.error) {
      this.onError?.(pick.error);
      return;
    }
    let room = pick.room;

    // Standing invite? Accept it and drop into the now-joined room.
    if (room?.getMyMembership() === "invite") {
      try {
        await this.client.joinRoom(room.roomId);
        room = this.client.getRoom(room.roomId) ?? room;
      } catch {
        this.onError?.("Couldn't accept the room invite.");
        return;
      }
    }

    if (!room) {
      this.onError?.(NO_ROOM_ERROR);
      return;
    }

    this.roomId = room.roomId;
    this.roomName = room.name || "Chat";
    this.ready = true;

    // Render whatever history is already loaded; messages from a freshly
    // accepted invite stream in live via the timeline as the next sync lands.
    for (const event of room.getLiveTimeline().getEvents()) {
      const message = this.consume(event);
      if (message) this.onMessage?.(message, false);
    }

    this.onStatus?.("online");
    this.onReady?.();
  }

  private pickRoom(): RoomPick<Room> {
    if (this.config.room) {
      const room = this.client.getRoom(this.config.room) ?? undefined;
      return room && isUsableRoom(room) ? { room } : { error: REQUESTED_ROOM_ERROR };
    }
    return pickDefaultRoom(this.client.getRooms());
  }

  // Render a single event exactly once. Returns null for anything that isn't a
  // displayable message (state events, redactions, duplicates).
  private consume(event: MatrixEvent): Message | null {
    const id = event.getId();
    if (!id || this.rendered.has(id)) return null;
    this.rendered.add(id);

    if (event.getType() !== "m.room.message" || event.isRedacted()) return null;

    const content = event.getContent();
    if (!content.msgtype) return null;

    const sender = event.getSender() ?? "";
    const room = this.client.getRoom(this.roomId);
    const base = {
      id,
      sender,
      senderName: room?.getMember(sender)?.rawDisplayName || shortName(sender),
      ts: event.getTs(),
      mine: sender === this.client.getUserId(),
      isVoice: false,
    };

    switch (content.msgtype) {
      case "m.text":
      case "m.notice":
      case "m.emote": {
        const body = String(content.body ?? "");
        return { ...base, kind: isEmojiOnly(body) ? "emoji" : "text", body };
      }
      case "m.image":
        return {
          ...base,
          kind: "image",
          body: String(content.body ?? ""),
          mxc: content.url,
          mimetype: content.info?.mimetype,
          width: dimension(content.info?.w),
          height: dimension(content.info?.h),
        };
      case "m.audio":
        return {
          ...base,
          kind: "audio",
          body: String(content.body ?? ""),
          mxc: content.url,
          mimetype: content.info?.mimetype,
          duration: content["org.matrix.msc1767.audio"]?.duration ?? content.info?.duration,
          isVoice: Boolean(content["org.matrix.msc3245.voice"]),
        };
      case "m.video":
        return {
          ...base,
          kind: "video",
          body: String(content.body ?? ""),
          mxc: content.url,
          mimetype: content.info?.mimetype,
          width: dimension(content.info?.w),
          height: dimension(content.info?.h),
        };
      case "m.file":
        return {
          ...base,
          kind: "file",
          body: String(content.body ?? "file"),
          mxc: content.url,
          mimetype: content.info?.mimetype,
        };
      default:
        return { ...base, kind: "unknown", body: String(content.body ?? "") };
    }
  }
}

// A positive, finite pixel dimension from event `info`, or undefined. Used to
// reserve layout space before media loads so the timeline doesn't jump.
function dimension(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 && Number.isFinite(value) ? value : undefined;
}

function shortName(userId: string): string {
  const match = /^@([^:]+):/.exec(userId);
  return match ? match[1] : userId;
}

// True when a message is nothing but emoji (and whitespace) — rendered large
// and bubble-free so it reads as a sticker.
function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !/\p{Extended_Pictographic}/u.test(trimmed)) return false;

  // Walk grapheme clusters so multi-codepoint emoji (skin tones, ZWJ families)
  // count as one. Anything that isn't whitespace or an emoji disqualifies it.
  let count = 0;
  for (const { segment } of new Intl.Segmenter().segment(trimmed)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!/\p{Extended_Pictographic}/u.test(segment)) return false;
    if (++count > 12) return false;
  }
  return count > 0;
}
