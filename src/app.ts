// The screen a toddler actually sees: a scrolling timeline up top, and a fat
// composer at the bottom with one microphone button and a strip of emoji.
// All DOM lives here; all Matrix talk lives in `Matrix`.

import { EMOJI } from "./emoji";
import type { Matrix, Message, Status } from "./matrix";

export class App {
  private readonly matrix: Matrix;

  private root!: HTMLElement;
  private timeline!: HTMLElement;
  private status!: HTMLElement;
  private title!: HTMLElement;
  private mic!: HTMLButtonElement;

  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private recordStart = 0;
  private loadingOlder = false;
  private hasInteracted = false;

  constructor(matrix: Matrix) {
    this.matrix = matrix;

    matrix.onStatus = (s) => this.setStatus(s);
    matrix.onReady = () => this.onReady();
    matrix.onError = (msg) => this.fatal(msg);
    matrix.onMessage = (m, live) => this.addMessage(m, live, false);
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.innerHTML = `
      <header class="bar">
        <span class="status" id="status" aria-hidden="true"></span>
        <span class="title" id="title">…</span>
      </header>
      <main class="timeline" id="timeline" aria-live="polite"></main>
      <footer class="composer">
        <button class="mic" id="mic" type="button" aria-label="Record a voice message">🎤</button>
        <div class="emojis" id="emojis"></div>
      </footer>
    `;

    this.timeline = byId(root, "timeline");
    this.status = byId(root, "status");
    this.title = byId(root, "title");
    this.mic = byId(root, "mic") as HTMLButtonElement;

    this.buildEmojiBar(byId(root, "emojis"));
    this.mic.addEventListener("click", () => void this.toggleRecording());
    this.timeline.addEventListener("scroll", () => this.onScroll());
    // Any tap counts as the user gesture that unlocks audio autoplay.
    root.addEventListener(
      "pointerdown",
      () => {
        this.hasInteracted = true;
      },
      { once: true },
    );
  }

  // --- composer ------------------------------------------------------------

  private buildEmojiBar(container: HTMLElement): void {
    for (const emoji of EMOJI) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji";
      button.textContent = emoji;
      button.setAttribute("aria-label", `Send ${emoji}`);
      button.addEventListener("click", () => void this.sendEmoji(button, emoji));
      container.appendChild(button);
    }
  }

  private async sendEmoji(button: HTMLButtonElement, emoji: string): Promise<void> {
    button.classList.add("pop");
    button.addEventListener("animationend", () => button.classList.remove("pop"), { once: true });
    try {
      await this.matrix.sendEmoji(emoji);
    } catch {
      this.toast("Couldn't send 😕");
    }
  }

  private async toggleRecording(): Promise<void> {
    if (this.recorder) {
      this.recorder.stop();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.toast("No microphone 🎤");
      return;
    }

    this.chunks = [];
    this.recordStart = Date.now();
    const recorder = new MediaRecorder(stream, pickRecorderOptions());

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      this.recorder = undefined;
      const duration = Date.now() - this.recordStart;
      const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
      // Ignore accidental taps that produce a blip of silence.
      if (blob.size > 0 && duration >= 400) void this.deliverVoice(blob, duration);
      else this.setMic("idle");
    });

    this.recorder = recorder;
    recorder.start();
    this.setMic("recording");
  }

  private async deliverVoice(blob: Blob, duration: number): Promise<void> {
    this.setMic("sending");
    try {
      await this.matrix.sendVoice(blob, duration);
    } catch {
      this.toast("Couldn't send 😕");
    } finally {
      this.setMic("idle");
    }
  }

  private setMic(state: "idle" | "recording" | "sending"): void {
    this.mic.classList.toggle("recording", state === "recording");
    this.mic.classList.toggle("sending", state === "sending");
    this.mic.textContent = state === "recording" ? "⏹️" : state === "sending" ? "⏳" : "🎤";
    this.mic.disabled = state === "sending";
  }

  // --- timeline ------------------------------------------------------------

  private onReady(): void {
    this.title.textContent = this.matrix.roomName || "Chat";
    this.scrollToBottom();
  }

  private addMessage(message: Message, live: boolean, prepend: boolean): void {
    const stick = !prepend && this.isNearBottom();
    const element = this.renderMessage(message, live);

    if (prepend) {
      const previousHeight = this.timeline.scrollHeight;
      this.timeline.prepend(element);
      // Keep the reading position fixed while older messages slot in above.
      this.timeline.scrollTop += this.timeline.scrollHeight - previousHeight;
    } else {
      this.timeline.appendChild(element);
      if (stick) this.scrollToBottom();
    }
  }

  private renderMessage(message: Message, live: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = `msg ${message.mine ? "mine" : "theirs"} ${message.kind}`;

    if (!message.mine && message.kind !== "emoji") {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = message.senderName;
      row.appendChild(who);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    this.fillBubble(bubble, row, message, live);
    row.appendChild(bubble);
    return row;
  }

  private fillBubble(bubble: HTMLElement, row: HTMLElement, message: Message, live: boolean): void {
    switch (message.kind) {
      case "emoji":
        bubble.textContent = message.body;
        return;
      case "text":
        bubble.textContent = message.body;
        return;
      case "image": {
        const img = document.createElement("img");
        img.className = "photo";
        img.alt = message.body || "photo";
        img.loading = "lazy";
        this.loadMedia(
          message.mxc,
          (url) => {
            img.src = url;
            this.scrollIfStuck();
          },
          bubble,
        );
        bubble.appendChild(img);
        return;
      }
      case "audio": {
        row.classList.add(message.isVoice ? "voice" : "file");
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "metadata";
        this.loadMedia(
          message.mxc,
          (url) => {
            audio.src = url;
            if (live && message.isVoice && !message.mine && this.hasInteracted) {
              void audio.play().catch(() => undefined);
            }
          },
          bubble,
        );
        bubble.appendChild(audio);
        return;
      }
      case "video": {
        const video = document.createElement("video");
        video.className = "photo";
        video.controls = true;
        video.playsInline = true;
        video.preload = "metadata";
        this.loadMedia(
          message.mxc,
          (url) => {
            video.src = url;
          },
          bubble,
        );
        bubble.appendChild(video);
        return;
      }
      case "file": {
        const link = document.createElement("a");
        link.className = "filelink";
        link.textContent = `📎 ${message.body}`;
        link.rel = "noopener";
        this.loadMedia(
          message.mxc,
          (url) => {
            link.href = url;
            link.download = message.body;
          },
          bubble,
        );
        bubble.appendChild(link);
        return;
      }
      default:
        bubble.textContent = message.body || "…";
    }
  }

  private loadMedia(
    mxc: string | undefined,
    apply: (url: string) => void,
    bubble: HTMLElement,
  ): void {
    if (!mxc) return;
    this.matrix
      .mediaUrl(mxc)
      .then(apply)
      .catch(() => {
        bubble.classList.add("broken");
        bubble.textContent = "📷 (couldn't load)";
      });
  }

  // --- scrolling -----------------------------------------------------------

  private onScroll(): void {
    if (this.timeline.scrollTop > 60 || this.loadingOlder) return;
    this.loadingOlder = true;
    void this.matrix
      .loadOlder()
      .then((older) => {
        for (const message of older) this.addMessage(message, false, true);
      })
      .finally(() => {
        this.loadingOlder = false;
      });
  }

  private isNearBottom(): boolean {
    const gap = this.timeline.scrollHeight - this.timeline.scrollTop - this.timeline.clientHeight;
    return gap < 120;
  }

  private scrollIfStuck(): void {
    if (this.isNearBottom()) this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.timeline.scrollTop = this.timeline.scrollHeight;
  }

  // --- chrome --------------------------------------------------------------

  private setStatus(status: Status): void {
    this.status.className = `status ${status}`;
  }

  private toast(text: string): void {
    const note = document.createElement("div");
    note.className = "toast";
    note.textContent = text;
    this.root.appendChild(note);
    note.addEventListener("animationend", () => note.remove(), { once: true });
  }

  fatal(message: string, onEdit?: () => void): void {
    if (!this.root) return;
    const editButton = onEdit
      ? `<button type="button" id="edit" class="primary">Edit link</button>`
      : "";
    this.root.innerHTML = `<div class="fatal"><div class="face">😴</div><p>${escapeHtml(message)}</p>${editButton}</div>`;
    const edit = this.root.querySelector<HTMLButtonElement>("#edit");
    if (edit && onEdit) edit.addEventListener("click", onEdit);
  }
}

function pickRecorderOptions(): MediaRecorderOptions | undefined {
  const preferred = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"];
  for (const mimeType of preferred) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType };
    }
  }
  return undefined;
}

function byId(root: HTMLElement, id: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
