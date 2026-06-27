#!/usr/bin/env bash
set -euo pipefail

CDP_CLI="${CDP_CLI:-$HOME/.agents/skills/brave-cdp/scripts/cdp.mjs}"
TARGET="${TARGET:-}"
ACTION="${1:-start}"

if [[ ! -x "$CDP_CLI" ]]; then
  echo "CDP CLI not found or not executable: $CDP_CLI" >&2
  exit 2
fi
if [[ -z "$TARGET" ]]; then
  echo "TARGET is required. Run '$CDP_CLI list' and pass TARGET=<tab-id> $0 start|dump|stop." >&2
  exit 2
fi

case "$ACTION" in
  start)
    "$CDP_CLI" eval "$TARGET" '(() => {
      window.__planWheelRecorder = [];
      if (window.__planWheelRecorderStop) window.__planWheelRecorderStop();
      const stops = [];
      const record = (source, phase, event) => {
        const iframe = document.querySelector("#plan-frame");
        const nav = document.querySelector("#plan-list-nav");
        const touchLayer = document.querySelector("#plan-touch-layer");
        const layerStyle = touchLayer ? getComputedStyle(touchLayer) : null;
        const doc = source === "iframe" ? iframe?.contentDocument : document;
        const hit = doc?.elementFromPoint(event.clientX, event.clientY);
        window.__planWheelRecorder.push({
          source,
          phase,
          time: performance.now(),
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          defaultPrevented: event.defaultPrevented,
          eventTarget: event.target?.id || event.target?.tagName || "",
          pointTarget: hit?.id || hit?.tagName || "",
          windowScrollY: window.scrollY,
          navScrollTop: nav?.scrollTop ?? null,
          frameInternalScrollY: iframe?.contentWindow?.scrollY ?? null,
          touchLayerDisplay: layerStyle?.display || "",
          touchLayerPointerEvents: layerStyle?.pointerEvents || ""
        });
      };
      const attach = (targetWindow, source) => {
        if (!targetWindow) return;
        const before = event => record(source, "capture", event);
        const after = event => requestAnimationFrame(() => record(source, "after-frame", event));
        targetWindow.addEventListener("wheel", before, { capture: true, passive: true });
        targetWindow.addEventListener("wheel", after, { capture: false, passive: true });
        stops.push(() => {
          targetWindow.removeEventListener("wheel", before, { capture: true });
          targetWindow.removeEventListener("wheel", after, { capture: false });
        });
      };
      attach(window, "parent");
      attach(document.querySelector("#plan-frame")?.contentWindow, "iframe");
      window.__planWheelRecorderStop = () => stops.splice(0).forEach(stop => stop());
      return { armed: true, url: location.href, title: document.title, sources: ["parent", "iframe"] };
    })()'
    ;;
  dump)
    "$CDP_CLI" eval "$TARGET" '(() => window.__planWheelRecorder || [])()'
    ;;
  stop)
    "$CDP_CLI" eval "$TARGET" '(() => { if (window.__planWheelRecorderStop) window.__planWheelRecorderStop(); return window.__planWheelRecorder || []; })()'
    ;;
  *)
    echo "usage: $0 start|dump|stop" >&2
    exit 2
    ;;
esac
