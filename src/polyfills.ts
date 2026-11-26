/**
 * Small stand-ins for newer browser features the peer-to-peer library uses, so the app
 * also runs on older iPhones/iPads (iOS 15.4 – 17.3) and older Safari on Mac.
 * Each one is only added when the browser doesn't have it.
 */

type Resolvers<T> = { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (r?: unknown) => void };

const P = Promise as unknown as { withResolvers?: <T>() => Resolvers<T> };
if (typeof P.withResolvers !== 'function') {
  P.withResolvers = <T,>(): Resolvers<T> => {
    let resolve!: Resolvers<T>['resolve'];
    let reject!: Resolvers<T>['reject'];
    const promise = new Promise<T>((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };
}

const AS = (typeof AbortSignal === 'undefined' ? undefined : AbortSignal) as unknown as
  | { any?: (signals: AbortSignal[]) => AbortSignal }
  | undefined;
if (AS && typeof AS.any !== 'function') {
  AS.any = (signals: AbortSignal[]) => {
    const ctrl = new AbortController();
    for (const s of signals) {
      if (s.aborted) {
        ctrl.abort(s.reason);
        break;
      }
      s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
    }
    return ctrl.signal;
  };
}

// Safari before 16 (iOS 15.4–15.8): used when checking Google sign-ins.
const AT = AS as unknown as { timeout?: (ms: number) => AbortSignal } | undefined;
if (AT && typeof AT.timeout !== 'function') {
  AT.timeout = (ms: number) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return ctrl.signal;
  };
}

const AP = Array.prototype as unknown as { toSorted?: unknown };
if (typeof AP.toSorted !== 'function') {
  Object.defineProperty(Array.prototype, 'toSorted', {
    value: function toSorted<T>(this: T[], compare?: (a: T, b: T) => number) {
      return [...this].sort(compare);
    },
    writable: true,
    configurable: true,
  });
}

export {};
