"use client";

import { useLayoutEffect } from "react";
import {
  createClientTraceBatcher,
  createQuickHackObservedFetch,
} from "@/quickhack_client/observability/client-http-trace";

export function ClientHttpTraceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useLayoutEffect(() => {
    const previousFetch = window.fetch;
    const nativeFetch = previousFetch.bind(window);
    const batcher = createClientTraceBatcher(nativeFetch);
    const observedFetch = createQuickHackObservedFetch({
      nativeFetch,
      report: batcher.enqueue,
      baseUrl: window.location.href,
    });

    window.fetch = observedFetch;
    window.addEventListener("pagehide", batcher.flushWithBeacon);

    return () => {
      window.removeEventListener("pagehide", batcher.flushWithBeacon);
      if (window.fetch === observedFetch) window.fetch = previousFetch;
      batcher.dispose();
    };
  }, []);

  return children;
}
