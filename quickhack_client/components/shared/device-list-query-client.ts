"use client";

import * as React from "react";
import type {
  DeviceListPage,
  DeviceListRow,
} from "@/quickhack_shared/device/device-list-query";
import type { DeviceListItem } from "@/quickhack_shared/device/types";
import type {
  DeviceHistoryPage,
  DeviceHistorySection,
} from "@/quickhack_shared/device/device-history";

type DeviceListApiResponse = {
  ok: boolean;
  message?: string;
  data?: DeviceListPage;
};

type DeviceDetailApiResponse = {
  ok: boolean;
  message?: string;
  data?: DeviceListItem;
};

type DeviceHistoryApiResponse = {
  ok: boolean;
  message?: string;
  data?: DeviceHistoryPage;
};

function requestUrl(endpoint: string, queryString: string, cursor?: string | null) {
  const params = new URLSearchParams(queryString);
  if (cursor) params.set("cursor", cursor);
  else params.delete("cursor");
  const search = params.toString();
  return search ? `${endpoint}?${search}` : endpoint;
}

async function requestDeviceListPage(
  endpoint: string,
  queryString: string,
  cursor: string | null,
  signal?: AbortSignal
) {
  const response = await fetch(requestUrl(endpoint, queryString, cursor), {
    cache: "no-store",
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | DeviceListApiResponse
    | null;

  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.message || "기기 목록을 불러오지 못했습니다.");
  }
  return payload.data;
}

export async function requestDeviceDetail(pgNo: string, signal?: AbortSignal) {
  const response = await fetch(
    `/api/inventory/devices/${encodeURIComponent(pgNo)}`,
    { cache: "no-store", signal }
  );
  const payload = (await response.json().catch(() => null)) as
    | DeviceDetailApiResponse
    | null;

  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.message || "기기 상세 정보를 불러오지 못했습니다.");
  }
  return payload.data;
}

export async function requestDeviceHistoryPage(
  pgNo: string,
  section: DeviceHistorySection,
  cursor: string | null = null,
  signal?: AbortSignal
) {
  const params = new URLSearchParams({ section, limit: "20" });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(
    `/api/inventory/devices/${encodeURIComponent(pgNo)}/history?${params.toString()}`,
    { cache: "no-store", signal }
  );
  const payload = (await response.json().catch(() => null)) as
    | DeviceHistoryApiResponse
    | null;

  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.message || "기기 이력을 불러오지 못했습니다.");
  }
  return payload.data;
}

export function useDeviceListQuery({
  endpoint,
  queryString,
  autoLoadAll = false,
}: {
  endpoint: string;
  queryString: string;
  autoLoadAll?: boolean;
}) {
  const [items, setItems] = React.useState<DeviceListRow[]>([]);
  const [facets, setFacets] = React.useState<DeviceListPage["facets"]>();
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [error, setError] = React.useState("");
  const requestSequenceRef = React.useRef(0);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const reload = React.useCallback(async () => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsLoading(true);
    setIsLoadingMore(false);
    setError("");

    try {
      const loaded: DeviceListRow[] = [];
      let cursor: string | null = null;
      let lastPage: DeviceListPage | null = null;

      do {
        lastPage = await requestDeviceListPage(
          endpoint,
          queryString,
          cursor,
          controller.signal
        );
        loaded.push(...lastPage.items);
        cursor = autoLoadAll ? lastPage.nextCursor : null;
      } while (cursor);

      if (requestSequenceRef.current === requestSequence) {
        setItems(loaded);
        setFacets(lastPage?.facets);
        setNextCursor(autoLoadAll ? null : lastPage?.nextCursor ?? null);
      }
      return loaded;
    } catch (loadError) {
      if (controller.signal.aborted) throw loadError;
      const message =
        loadError instanceof Error ? loadError.message : String(loadError);
      if (requestSequenceRef.current === requestSequence) {
        setItems([]);
        setNextCursor(null);
        setError(message);
      }
      throw loadError;
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        setIsLoading(false);
      }
    }
  }, [autoLoadAll, endpoint, queryString]);

  React.useEffect(() => {
    let canceled = false;
    queueMicrotask(() => {
      if (!canceled) void reload().catch(() => undefined);
    });
    return () => {
      canceled = true;
      abortControllerRef.current?.abort();
    };
  }, [reload]);

  const loadMore = React.useCallback(async () => {
    if (!nextCursor || isLoading || isLoadingMore) return;
    const requestSequence = requestSequenceRef.current;
    setIsLoadingMore(true);
    setError("");

    try {
      const page = await requestDeviceListPage(
        endpoint,
        queryString,
        nextCursor,
        abortControllerRef.current?.signal
      );
      if (requestSequenceRef.current === requestSequence) {
        setItems((current) => [...current, ...page.items]);
        setNextCursor(page.nextCursor);
      }
    } catch (loadError) {
      if (!abortControllerRef.current?.signal.aborted) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        setIsLoadingMore(false);
      }
    }
  }, [endpoint, isLoading, isLoadingMore, nextCursor, queryString]);

  return {
    items,
    facets,
    nextCursor,
    hasMore: Boolean(nextCursor),
    isLoading,
    isLoadingMore,
    error,
    reload,
    loadMore,
  };
}
