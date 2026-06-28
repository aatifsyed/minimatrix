// Shown when the app is opened without a usable magic link. Aimed at the parent:
// fill in the fields, copy the generated link (or open it straight away), and
// save it to the child's home screen. Prefilled from any partial link present.

import { buildHash, type RawParams } from "./config";

const FIELDS = [
  { key: "homeserver", label: "Homeserver", placeholder: "matrix.example", type: "text" },
  { key: "user", label: "Username", placeholder: "tot", type: "text" },
  { key: "password", label: "Password", placeholder: "secret", type: "text" },
  { key: "room", label: "Room ID (optional)", placeholder: "!abc:matrix.example", type: "text" },
] as const;

export function renderSetup(root: HTMLElement, prefill: RawParams): void {
  root.innerHTML = `
    <form class="setup" id="setup" autocomplete="off" novalidate>
      <div class="face">🔑</div>
      <h1>Make a magic link</h1>
      <p class="muted">Fill this in once, then copy the link and save it to the child's home screen.</p>

      ${FIELDS.map(
        (f) => `
        <label class="field">
          <span>${f.label}</span>
          <input name="${f.key}" type="${f.type}" inputmode="${f.key === "homeserver" ? "url" : "text"}"
                 placeholder="${f.placeholder}" autocapitalize="none" spellcheck="false" />
        </label>`,
      ).join("")}

      <label class="field">
        <span>Magic link</span>
        <input name="link" id="link" class="link" type="text" readonly placeholder="Fill the fields above" />
      </label>

      <div class="actions">
        <button type="button" id="copy" class="primary" disabled>Copy link</button>
        <button type="submit" id="open" disabled>Open now</button>
      </div>
    </form>
  `;

  const form = byId<HTMLFormElement>(root, "setup");
  const linkInput = byId<HTMLInputElement>(root, "link");
  const copyBtn = byId<HTMLButtonElement>(root, "copy");
  const openBtn = byId<HTMLButtonElement>(root, "open");

  const inputs = new Map<string, HTMLInputElement>();
  for (const f of FIELDS) {
    const input = form.elements.namedItem(f.key) as HTMLInputElement;
    input.value = prefill[f.key];
    input.addEventListener("input", refresh);
    inputs.set(f.key, input);
  }

  function currentFields(): RawParams {
    return {
      homeserver: inputs.get("homeserver")!.value,
      user: inputs.get("user")!.value,
      password: inputs.get("password")!.value,
      room: inputs.get("room")!.value,
    };
  }

  function isComplete(f: RawParams): boolean {
    return Boolean(f.homeserver.trim() && f.user.trim() && f.password);
  }

  function refresh(): void {
    const fields = currentFields();
    const ready = isComplete(fields);
    const link = ready ? linkFor(fields) : "";
    linkInput.value = link;
    copyBtn.disabled = !ready;
    openBtn.disabled = !ready;
    copyBtn.textContent = "Copy link";
  }

  copyBtn.addEventListener("click", () => {
    const link = linkInput.value;
    if (!link) return;
    copyToClipboard(link, linkInput).then(
      () => {
        copyBtn.textContent = "Copied ✓";
      },
      () => {
        copyBtn.textContent = "Press ⌘/Ctrl + C";
        linkInput.select();
      },
    );
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = currentFields();
    if (!isComplete(fields)) return;
    // Re-enter the app with the new link; main.ts reads the hash on load.
    location.hash = buildHash(fields);
    location.reload();
  });

  refresh();
}

function linkFor(fields: RawParams): string {
  return `${location.origin}${location.pathname}${buildHash(fields)}`;
}

async function copyToClipboard(text: string, fallback: HTMLInputElement): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Older / non-secure contexts: select the field and use execCommand.
  fallback.select();
  if (!document.execCommand("copy")) throw new Error("copy unavailable");
}

function byId<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const el = root.querySelector<T>(`#${id}`);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}
