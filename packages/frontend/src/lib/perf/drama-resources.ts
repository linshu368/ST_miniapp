import {
  DRAMA_TIMING_MAX_RESOURCES,
  type DramaNetworkTiming,
  type DramaResourceTiming,
} from '@miniapp/shared';
import type { DramaPlaybackTiming } from './drama-timing';

const finite = (n: number) => Number.isFinite(n);
const round = (n: number) => Math.round(n * 10) / 10;
function supports(type: string): boolean {
  try {
    return (
      typeof PerformanceObserver !== 'undefined' &&
      Boolean(PerformanceObserver.supportedEntryTypes?.includes(type))
    );
  } catch {
    return false;
  }
}
const duration = (end: number, start: number) =>
  finite(end) && finite(start) && end >= start ? round(end - start) : undefined;

/** Never copy PerformanceEntry.name: it contains the signed credential. */
export function mediaResourceFields(
  entry: PerformanceResourceTiming,
  origin: number
): DramaResourceTiming | undefined {
  if (![entry.startTime, entry.fetchStart, entry.responseEnd].every(finite)) return;
  const detailed = entry.requestStart > 0 && entry.responseStart >= entry.requestStart;
  const protocol = entry.nextHopProtocol;
  return {
    startMs: round(entry.startTime - origin),
    fetchStartMs: round(entry.fetchStart - origin),
    responseEndMs: round(entry.responseEnd - origin),
    visibility: detailed ? 'detailed' : 'limited',
    ...(detailed
      ? {
          requestStartMs: round(entry.requestStart - origin),
          responseStartMs: round(entry.responseStart - origin),
          dnsMs: duration(entry.domainLookupEnd, entry.domainLookupStart),
          connectMs: duration(entry.connectEnd, entry.connectStart),
          tlsMs:
            entry.secureConnectionStart > 0
              ? duration(entry.connectEnd, entry.secureConnectionStart)
              : undefined,
          ttfbMs: duration(entry.responseStart, entry.requestStart),
          responseMs: duration(entry.responseEnd, entry.responseStart),
          // Zero sizes can mean an opaque response/cache; don't pretend they prove either.
          encodedBodyBytes:
            entry.encodedBodySize > 0 && entry.encodedBodySize <= 1e12
              ? entry.encodedBodySize
              : undefined,
          transferBytes:
            entry.transferSize > 0 && entry.transferSize <= 1e12 ? entry.transferSize : undefined,
          protocol:
            protocol === 'h2'
              ? ('h2' as const)
              : protocol === 'h3'
                ? ('h3' as const)
                : protocol === 'http/1.1'
                  ? ('http1' as const)
                  : protocol
                    ? ('other' as const)
                    : undefined,
        }
      : {}),
  };
}

/** Passive observation only: no probe requests, fetch interception, or global buffer clearing. */
export function observeDramaResources(source: string, timing: DramaPlaybackTiming): () => void {
  const entries: DramaResourceTiming[] = [];
  const seen = new Set<string>();
  const sourceAt = timing.marks.source_set ?? timing.startedAt;
  let truncated = false;
  let disposed = false;
  let changedAfterFinal = false;
  let observer: PerformanceObserver | undefined;
  let tail: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let unfinish = () => {};
  const supported = supports('resource');
  const snapshot = (closed?: DramaNetworkTiming['closed']): DramaNetworkTiming => ({
    status: !supported
      ? 'unsupported'
      : !entries.length
        ? 'no_entry'
        : entries.some((entry) => entry.visibility === 'detailed')
          ? 'available'
          : 'limited',
    entries: entries.map((entry) => ({ ...entry })),
    truncated,
    closed,
  });
  const accept = (resources: PerformanceEntry[]) => {
    if (disposed) return;
    for (const resource of resources) {
      // Same URL reused by a later src generation must not steal an earlier request.
      if (
        resource.entryType !== 'resource' ||
        resource.name !== source ||
        resource.startTime < sourceAt
      )
        continue;
      const entry = resource as PerformanceResourceTiming;
      const key = `${entry.startTime}/${entry.responseEnd}/${entry.duration}`;
      if (seen.has(key)) continue;
      if (entries.length >= DRAMA_TIMING_MAX_RESOURCES) {
        if (!truncated && timing.outcome) changedAfterFinal = true;
        truncated = true;
        continue;
      }
      const fields = mediaResourceFields(entry, timing.startedAt);
      if (!fields) continue;
      seen.add(key);
      entries.push(fields);
      if (timing.outcome) changedAfterFinal = true;
    }
    timing.networkTiming(snapshot());
  };
  const close = (reason: NonNullable<DramaNetworkTiming['closed']>) => {
    if (disposed) return;
    try {
      if (observer) accept(observer.takeRecords());
    } catch {
      /* optional WebView reader */
    }
    disposed = true;
    clearTimeout(tail);
    clearTimeout(deadline);
    try {
      observer?.disconnect();
    } catch {
      /* still release the timers and flow below */
    }
    unfinish();
    timing.networkTiming(snapshot(reason), changedAfterFinal);
    seen.clear();
  };
  timing.networkTiming(snapshot());
  if (!supported) return () => close('released');
  try {
    observer = new PerformanceObserver((list) => accept(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
    accept(performance.getEntriesByType('resource'));
    deadline = setTimeout(
      () => close('deadline'),
      Math.max(0, 60_000 - (performance.now() - sourceAt))
    );
    unfinish = timing.onFinish((outcome) => {
      if (outcome !== 'playing' && outcome !== 'error') close('released');
      else tail = setTimeout(() => close('terminal_tail'), 5_000);
    });
  } catch {
    try {
      observer?.disconnect();
    } catch {
      /* unsupported observer */
    }
    disposed = true;
    timing.networkTiming({ status: 'unsupported', entries: [], truncated: false });
  }
  return () => close('released');
}

export function observeDramaLongTasks(timing: DramaPlaybackTiming): () => void {
  const tasks: { start: number; end: number }[] = [];
  let truncated = false;
  let observer: PerformanceObserver | undefined;
  let supported = supports('longtask');
  const accept = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (
        !finite(entry.startTime) ||
        !finite(entry.duration) ||
        entry.duration < 0 ||
        entry.startTime + entry.duration < timing.startedAt
      )
        continue;
      if (tasks.length >= 128) {
        truncated = true;
        break;
      }
      tasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
    }
  };
  if (supported) {
    try {
      observer = new PerformanceObserver((list) => accept(list.getEntries()));
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      supported = false;
      try {
        observer?.disconnect();
      } catch {
        /* unsupported observer */
      }
    }
  }
  const unbind = timing.bindLongTasks(() => {
    try {
      if (observer) accept(observer.takeRecords());
    } catch {
      supported = false;
    }
    const end = performance.now();
    const overlap = (task: { start: number; end: number }, start: number, finish: number) =>
      Math.max(0, Math.min(task.end, finish) - Math.max(task.start, start));
    const lengths = tasks.map((task) => overlap(task, timing.startedAt, end));
    return {
      support: supported ? 'supported' : 'unsupported',
      count: lengths.filter((length) => length > 0).length,
      totalMs: round(lengths.reduce((sum, length) => sum + length, 0)),
      maxMs: round(Math.max(0, ...lengths)),
      metadataToFrameMs:
        timing.marks.metadata !== undefined && timing.marks.first_frame !== undefined
          ? round(
              tasks.reduce(
                (sum, task) =>
                  sum + overlap(task, timing.marks.metadata!, timing.marks.first_frame!),
                0
              )
            )
          : undefined,
      truncated,
    };
  });
  const stop = () => {
    try {
      observer?.disconnect();
    } catch {
      /* media cleanup must continue */
    }
    unbind();
    unfinish();
    tasks.length = 0;
  };
  const unfinish = timing.onFinish(stop);
  return stop;
}
