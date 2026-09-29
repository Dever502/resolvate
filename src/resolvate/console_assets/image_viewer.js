"use strict";

class ImageViewer {
  constructor() {
    const get = (id) => document.getElementById(id);
    this.dialog = get("image-viewer");
    this.stage = get("image-stage");
    this.image = get("image-full");
    this.label = get("image-reset");
    this.error = get("image-error");
    this.pointers = new Map();
    this.reset();
    get("image-close").onclick = () => this.close();
    get("image-zoom-in").onclick = () => this.zoomBy(1.5);
    get("image-zoom-out").onclick = () => this.zoomBy(1 / 1.5);
    this.label.onclick = () => this.reset();
    this.image.onload = () => this.reset();
    this.image.onerror = () => { if (this.dialog.open) this.error.hidden = false; };
    this.dialog.addEventListener("close", () => {
      if (this.dialog.open) return;
      this.image.removeAttribute("src");
      this.pointers.clear();
      this.reset();
    });
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) this.close();
    });
    this.dialog.addEventListener("keydown", (event) => {
      if (["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "0") this.reset();
        else this.zoomBy(event.key === "-" ? 1 / 1.5 : 1.5);
      }
    });
    this.stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoomBy(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.01), this.point(event));
    }, {passive: false});
    this.stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.stage.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, this.point(event));
      this.blankClick = event.target === this.stage && this.pointers.size === 1;
      this.moved = false;
      this.start = this.point(event);
    });
    this.stage.addEventListener("pointermove", (event) => this.move(event));
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.stage.addEventListener(name, (event) => {
        if (!this.pointers.has(event.pointerId)) return;
        const close = name === "pointerup" && this.blankClick && !this.moved && this.pointers.size === 1;
        this.pointers.delete(event.pointerId);
        this.blankClick = false;
        if (close) this.close();
      });
    }
    window.addEventListener("resize", () => { if (this.dialog.open) this.paint(); });
  }

  open(url) {
    this.pointers.clear();
    this.error.hidden = true;
    this.reset();
    this.image.src = url;
    this.dialog.showModal();
  }

  close() { if (this.dialog.open) this.dialog.close(); }

  reset() {
    this.scale = 1;
    this.x = this.y = 0;
    this.paint();
  }

  point(event) {
    const box = this.stage.getBoundingClientRect();
    return {x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2};
  }

  zoomBy(factor, point = {x: 0, y: 0}) {
    const next = Math.max(1, Math.min(8, this.scale * factor));
    const ratio = next / this.scale;
    this.x = point.x - (point.x - this.x) * ratio;
    this.y = point.y - (point.y - this.y) * ratio;
    this.scale = next;
    this.paint();
  }

  move(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const before = [...this.pointers.values()];
    const old = this.pointers.get(event.pointerId);
    const point = this.point(event);
    this.pointers.set(event.pointerId, point);
    if (Math.hypot(point.x - this.start.x, point.y - this.start.y) > 4) this.moved = true;
    if (this.pointers.size === 2) {
      const after = [...this.pointers.values()];
      const center = (pair) => ({x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2});
      const distance = (pair) => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      const a = center(before), b = center(after);
      this.zoomBy(distance(after) / Math.max(1, distance(before)), a);
      this.x += b.x - a.x;
      this.y += b.y - a.y;
      this.blankClick = false;
    } else if (this.pointers.size === 1 && this.scale > 1) {
      this.x += point.x - old.x;
      this.y += point.y - old.y;
    }
    this.paint();
  }

  paint() {
    const maxX = Math.max(0, (this.image.clientWidth * this.scale - this.stage.clientWidth) / 2);
    const maxY = Math.max(0, (this.image.clientHeight * this.scale - this.stage.clientHeight) / 2);
    this.x = Math.max(-maxX, Math.min(maxX, this.x));
    this.y = Math.max(-maxY, Math.min(maxY, this.y));
    this.image.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.stage.classList.toggle("zoomed", this.scale > 1);
    this.label.textContent = `${Math.round(this.scale * 100)}%`;
  }
}
