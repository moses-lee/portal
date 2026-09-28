import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function whose identity never changes but which always calls the latest `fn`. For handlers
 * handed to memoized children (the sidebar's rows): the parent re-renders on every list-stream
 * event, and an inline arrow would make every row re-render with it.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
