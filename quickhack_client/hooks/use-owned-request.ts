"use client";

import * as React from "react";

export type OwnedRequestTargetSnapshot = Readonly<{
  targetId: string;
  queryKey: string;
  revision: string | number | null;
}>;

export function createOwnedRequestTargetSnapshot(input: {
  targetId: string | number;
  queryKey: string;
  revision?: string | number | null;
}): OwnedRequestTargetSnapshot {
  const targetId = String(input.targetId).trim();
  const queryKey = input.queryKey.trim();
  if (!targetId || !queryKey) {
    throw new Error("Owned requests require an explicit target and query key.");
  }
  return Object.freeze({
    targetId,
    queryKey,
    revision: input.revision ?? null,
  });
}

function targetKey(snapshot: OwnedRequestTargetSnapshot) {
  return JSON.stringify([
    snapshot.targetId,
    snapshot.queryKey,
    snapshot.revision,
  ]);
}

export class OwnedRequestCoordinator {
  private generation = 0;
  private active:
    | {
        generation: number;
        targetKey: string;
        controller: AbortController;
      }
    | undefined;

  begin(snapshot: OwnedRequestTargetSnapshot) {
    this.active?.controller.abort();
    const generation = this.generation + 1;
    this.generation = generation;
    const controller = new AbortController();
    const expectedTargetKey = targetKey(snapshot);
    this.active = { generation, targetKey: expectedTargetKey, controller };

    const isCurrent = () =>
      this.active?.generation === generation &&
      this.active.targetKey === expectedTargetKey;

    return {
      generation,
      snapshot,
      signal: controller.signal,
      isCurrent,
      commit: (apply: () => void) => {
        if (!isCurrent()) return false;
        apply();
        return true;
      },
    } as const;
  }

  dispose() {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = undefined;
  }
}

export function useOwnedRequest() {
  const [coordinator] = React.useState(() => new OwnedRequestCoordinator());

  React.useEffect(
    () => () => {
      coordinator.dispose();
    },
    [coordinator]
  );

  return coordinator;
}
