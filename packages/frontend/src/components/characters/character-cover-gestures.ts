'use client';
import { useEffect, useRef, type MutableRefObject, type RefObject, type PointerEvent } from 'react';
import { recordCoverResize } from '@/lib/sentry/diagnostic-state';
export type CoverPoint = { x: number; y: number };
export type CoverView = CoverPoint & { scale: number };
type Point = CoverPoint;
type Move = (scale: number, from?: CoverPoint, to?: CoverPoint) => void;
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function useCoverGestures(current: MutableRefObject<CoverView>, move: Move) {
  const fingers = useRef(new Map<number, Point>());
  const tap = useRef<(Point & { time: number }) | null>(null);
  const previousTap = useRef<(Point & { time: number }) | null>(null);

  function point(event: PointerEvent<HTMLDivElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || fingers.current.size >= 2) return;
    const at = point(event);
    fingers.current.set(event.pointerId, at);
    event.currentTarget.setPointerCapture(event.pointerId);
    tap.current = fingers.current.size === 1 ? { ...at, time: event.timeStamp } : null;
    if (!tap.current) previousTap.current = null;
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    const before = fingers.current.get(event.pointerId);
    if (!before) return;
    const after = point(event);
    const second = [...fingers.current].find(([id]) => id !== event.pointerId)?.[1];
    fingers.current.set(event.pointerId, after);
    if (tap.current && distance(tap.current, after) > 10) {
      tap.current = null;
      previousTap.current = null;
    }
    if (second) {
      const ratio = distance(after, second) / Math.max(1, distance(before, second));
      move(current.current.scale * ratio, midpoint(before, second), midpoint(after, second));
    } else if (current.current.scale > 1) {
      move(current.current.scale, before, after);
    }
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    if (!fingers.current.delete(event.pointerId)) return;
    const at = point(event);
    const last = previousTap.current;
    if (
      event.type === 'pointerup' &&
      tap.current &&
      distance(tap.current, at) <= 10 &&
      event.timeStamp - tap.current.time < 350
    ) {
      if (last && event.timeStamp - last.time < 350 && distance(last, at) <= 30) {
        move(current.current.scale > 1 ? 1 : 2, at);
        previousTap.current = null;
      } else previousTap.current = { ...at, time: event.timeStamp };
    } else previousTap.current = null;
    tap.current = null;
  }

  return { start, drag, end };
}

export function useCoverResize(
  stage: RefObject<HTMLDivElement>,
  current: MutableRefObject<CoverView>,
  move: Move
) {
  const latestMove = useRef(move);
  latestMove.current = move;
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    recordCoverResize(true);
    const observer = new ResizeObserver(() => {
      recordCoverResize(true, true);
      // Defer writes until after ResizeObserver delivery, and coalesce a burst into one frame.
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        latestMove.current(current.current.scale);
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      recordCoverResize(false);
    };
  }, [stage, current]);
}
