"use strict";

// The light canvas build has no expression engine and is served locally, never by a CDN.
let stickerLibrary;
function loadStickerLibrary() {
  if (!stickerLibrary) stickerLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/console/assets/lottie_light_canvas.js";
    script.onload = () => {
      window.lottie.useWebWorker(false);
      resolve(window.lottie);
    };
    script.onerror = () => { stickerLibrary = null; script.remove(); reject(new Error("player")); };
    document.head.append(script);
  });
  return stickerLibrary;
}

class StickerPreview extends HTMLElement {
  connectedCallback() {
    if (this.controller) return;
    this.controller = new AbortController();
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "sticker-preview";
    this.button.setAttribute("aria-label", this.mime.startsWith("image/")
      ? "Открыть стикер" : "Воспроизвести стикер");
    this.label = document.createElement("span");
    this.label.className = "sticker-label muted";
    this.label.textContent = this.emoji ? `Стикер ${this.emoji}` : "Стикер";
    this.replaceChildren(this.button, this.label);
    this.button.disabled = true;
    this.observer = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting);
      if (visible && !this.started) {
        this.started = true;
        this.load(this.controller.signal).catch(error => {
          if (error.name !== "AbortError" && this.isConnected) this.failed();
        });
      } else if (!visible) this.pause();
    });
    this.observer.observe(this);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
    }, {signal: this.controller.signal});
  }

  async load(signal) {
    if (this.mime.startsWith("image/")) {
      const image = document.createElement("img");
      image.alt = this.emoji ? `Стикер ${this.emoji}` : "Стикер";
      image.src = this.src;
      image.onerror = () => this.failed();
      this.button.append(image);
      this.button.onclick = () => this.openImage?.(this.src);
    } else if (this.mime === "video/webm") {
      this.video = document.createElement("video");
      this.video.src = this.src;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.preload = "metadata";
      this.video.onerror = () => this.failed();
      this.button.append(this.video);
      this.button.onclick = () => {
        if (!this.video.paused) this.video.pause();
        else this.video.play().catch(() => this.failed());
      };
    } else if (this.mime === "application/x-tgsticker") {
      const response = await fetch(this.src, {signal, credentials: "same-origin"});
      if (!response.ok) throw new Error("unavailable");
      const animationData = await response.json();
      const library = await loadStickerLibrary();
      if (signal.aborted || !this.isConnected) return;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      canvas.setAttribute("aria-hidden", "true");
      this.button.append(canvas);
      this.animation = library.loadAnimation({
        renderer: "canvas", animationData, autoplay: false, loop: false,
        rendererSettings: {context: canvas.getContext("2d"), clearCanvas: true},
      });
      this.animation.addEventListener("data_failed", () => this.failed());
      this.animation.addEventListener("error", () => this.failed());
      this.animation.addEventListener("DOMLoaded", () => this.animation?.goToAndStop(0, true));
      this.button.onclick = () => {
        if (this.animation.isPaused) this.animation.goToAndPlay(0, true);
        else this.animation.pause();
      };
    } else throw new Error("format");
    if (!signal.aborted) this.button.disabled = false;
    // Motion starts only on request: no infinite loops, reduced-motion surprises
    // or a page full of players consuming CPU while the operator reads history.
  }

  pause() { this.video?.pause(); this.animation?.pause(); }
  failed() {
    this.pause();
    this.button.disabled = true;
    this.label.textContent = "Стикер недоступен";
  }
  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return; // Moving an existing message during polling is not teardown.
      this.controller?.abort();
      this.observer?.disconnect();
      this.pause();
      this.animation?.destroy();
      this.video?.removeAttribute("src");
      this.controller = this.animation = this.video = null;
      this.started = false;
      this.replaceChildren();
    });
  }
}
customElements.define("resolvate-sticker", StickerPreview);
