import "./style.css";
import { readParams, resolveConfig } from "./config";
import { Matrix } from "./matrix";
import { App } from "./app";
import { renderSetup } from "./setup";

const root = document.querySelector<HTMLDivElement>("#app");
if (root) start(root);

function start(root: HTMLDivElement): void {
  registerServiceWorker();

  const resolved = resolveConfig(currentUrlFragment());
  if (!resolved.config) {
    // No (or incomplete) link: show the setup form, prefilled with whatever
    // partial params were present so a half-built link can be finished.
    renderSetup(root, resolved.params);
    return;
  }

  const matrix = new Matrix(resolved.config);
  const app = new App(matrix);
  app.mount(root);

  matrix.start().catch((error: unknown) => {
    // Link looked complete but sign-in failed (wrong password, server down, …):
    // let the parent jump back to the form, prefilled, to fix it.
    app.fatal(error instanceof Error ? error.message : "Couldn't connect.", () => {
      matrix.stop();
      renderSetup(root, readParams(resolved.urlFragment));
    });
  });

  // Hang up cleanly so we don't leak sync connections on navigation away.
  window.addEventListener("pagehide", () => matrix.stop());
}

function currentUrlFragment(): string {
  const marker = location.href.indexOf("#");
  return marker === -1 ? "" : location.href.slice(marker);
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
