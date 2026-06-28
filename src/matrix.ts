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
  isVoice: boolean;
  mine: boolean;
}

export type Status = "connecting" | "online" | "offline";

const TIMELINE_LIMIT = 30;

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

  constructor(config: Config) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.onStatus?.("connecting");
    const baseUrl = this.config.homeserver;

    const login = createClient({ baseUrl });
    const session = await login.loginWithPassword(this.config.user, this.config.password);

    this.client = createClient({
      baseUrl,
      accessToken: session.access_token,
      userId: session.user_id,
      deviceId: session.device_id,
    });

    this.bindEvents();
    await this.client.startClient({ initialSyncLimit: TIMELINE_LIMIT });
  }

  stop(): void {
    this.client?.stopClient();
    for (const url of this.mediaCache.values()) URL.revokeObjectURL(url);
    this.mediaCache.clear();
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
    if (events.length === sizeBefore) return [];

    // Events are chronological (oldest first); the freshly fetched ones are the
    // not-yet-rendered prefix. Returned oldest-first, ready to prepend in order.
    const older: Message[] = [];
    for (const event of events) {
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
    if (cached) return cached;

    const blob = await this.fetchMedia(mxc);
    const url = URL.createObjectURL(blob);
    this.mediaCache.set(mxc, url);
    return url;
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

    let room = this.pickRoom();

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
      this.onError?.("No room is available for this account yet.");
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

  private pickRoom(): Room | undefined {
    if (this.config.room) {
      return this.client.getRoom(this.config.room) ?? undefined;
    }
    // Prefer a room we're already in; fall back to one we've been invited to.
    const rooms = this.client.getRooms();
    return (
      rooms.find((r) => r.getMyMembership() === "join") ??
      rooms.find((r) => r.getMyMembership() === "invite") ??
      rooms[0]
    );
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
