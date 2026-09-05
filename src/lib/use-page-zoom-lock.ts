"use client";

import { useEffect, useRef } from "react";

type ZoomLockOptions = {
  onZoomOut?: () => void;
};

function touchDistance(touches: TouchList) {
  const first = touches[0];
  const second = touches[1];
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

/** Prevents browser-level page zoom while leaving component-owned gestures active. */
export function usePageZoomLock({ onZoomOut }: ZoomLockOptions = {}) {
  const onZoomOutRef = useRef(onZoomOut);

  useEffect(() => {
    onZoomOutRef.current = onZoomOut;
  }, [onZoomOut]);

  useEffect(() => {
    let pinchStartDistance = 0;
    let exitTriggered = false;
    let wheelZoomOut = 0;
    let wheelReset = 0;

    function exitOnce() {
      if (exitTriggered || !onZoomOutRef.current) return;
      exitTriggered = true;
      onZoomOutRef.current();
    }

    function handleTouchStart(event: TouchEvent) {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      pinchStartDistance = touchDistance(event.touches);
      exitTriggered = false;
    }

    function handleTouchMove(event: TouchEvent) {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      const distance = touchDistance(event.touches);
      if (pinchStartDistance > 0 && distance / pinchStartDistance < 0.72) exitOnce();
    }

    function handleTouchEnd() {
      pinchStartDistance = 0;
      exitTriggered = false;
    }

    function handleGesture(event: Event) {
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale;
      if (typeof scale === "number" && scale < 0.72) exitOnce();
    }

    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (event.deltaY <= 0) {
        wheelZoomOut = 0;
        return;
      }
      wheelZoomOut += event.deltaY;
      window.clearTimeout(wheelReset);
      wheelReset = window.setTimeout(() => { wheelZoomOut = 0; }, 240);
      if (wheelZoomOut > 38) exitOnce();
    }

    document.addEventListener("touchstart", handleTouchStart, { passive: false });
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    document.addEventListener("gesturestart", handleGesture, { passive: false });
    document.addEventListener("gesturechange", handleGesture, { passive: false });
    document.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.clearTimeout(wheelReset);
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchEnd);
      document.removeEventListener("gesturestart", handleGesture);
      document.removeEventListener("gesturechange", handleGesture);
      document.removeEventListener("wheel", handleWheel);
    };
  }, []);
}
