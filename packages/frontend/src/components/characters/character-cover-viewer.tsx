'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

type Point = { x: number; y: number };
type View = Point & { scale: number };
const origin: View = { x: 0, y: 0, scale: 1 };
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const control =
  'absolute grid size-11 place-items-center rounded-full bg-black/55 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white';

interface CharacterCoverViewerProps {
  src: string;
  name: string;
  onClose: () => void;
  returnFocus: () => void;
}

export function CharacterCoverViewer({
  src,
  name,
  onClose,
  returnFocus,
}: CharacterCoverViewerProps) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState(origin);
  const current = useRef(origin);
  const [failed, setFailed] = useState(false);
  const fingers = useRef(new Map<number, Point>());
  const tap = useRef<(Point & { time: number }) | null>(null);
  const previousTap = useRef<(Point & { time: number }) | null>(null);

  function move(scale: number, from: Point = origin, to: Point = from) {
    if (!stage.current || !image.current?.naturalWidth) return;
    const { clientWidth: width, clientHeight: height } = stage.current;
    const { naturalWidth, naturalHeight } = image.current;
    const fit = Math.min(width / naturalWidth, height / naturalHeight);
    const old = current.current;
    // Keep the image point between the fingers stationary and keep the photo in reach.
    const nextScale = Math.min(4, Math.max(1, scale));
    const axis = (oldOffset: number, start: number, end: number, size: number, screen: number) => {
      const limit = Math.max(0, (size * fit * nextScale - screen) / 2);
      return Math.max(-limit, Math.min(limit, end - (start - oldOffset) * (nextScale / old.scale)));
    };
    const next =
      nextScale === 1
        ? origin
        : {
            scale: nextScale,
            x: axis(old.x, from.x, to.x, naturalWidth, width),
            y: axis(old.y, from.y, to.y, naturalHeight, height),
          };
    current.current = next;
    setView(next);
  }

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

  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => move(current.current.scale));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[71] overflow-hidden overscroll-none bg-black"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus();
          }}
        >
          <Dialog.Title className="sr-only">角色封面大图</Dialog.Title>
          <div
            ref={stage}
            className="absolute inset-0 touch-none select-none overflow-hidden"
            onPointerDown={start}
            onPointerMove={drag}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          >
            {failed ? (
              <p className="grid h-full place-items-center text-sm text-white/70">
                封面暂时无法加载
              </p>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- Show the original cover at its native aspect ratio.
              <img
                ref={image}
                src={src}
                alt={`${name}的角色封面`}
                draggable={false}
                onError={() => setFailed(true)}
                className="h-full w-full object-contain"
                style={{ transform: `translate3d(${view.x}px,${view.y}px,0) scale(${view.scale})` }}
              />
            )}
          </div>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="关闭大图"
              className={`${control} right-[calc(env(safe-area-inset-right)+0.75rem)] top-[calc(env(safe-area-inset-top)+0.75rem)]`}
            >
              <X className="size-5" aria-hidden />
            </button>
          </Dialog.Close>
          {!failed && (
            <button
              type="button"
              aria-label={view.scale > 1 ? '还原图片' : '放大图片'}
              onClick={() => move(current.current.scale > 1 ? 1 : 2)}
              className={`${control} right-[calc(env(safe-area-inset-right)+0.75rem)] bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]`}
            >
              {view.scale > 1 ? (
                <ZoomOut className="size-5" aria-hidden />
              ) : (
                <ZoomIn className="size-5" aria-hidden />
              )}
            </button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
