export type UnsavedEntryKind = "draft" | "one-time-result";

export type UnsavedFormEntry = {
  id: string;
  label: string;
  kind?: UnsavedEntryKind;
  isDirty: boolean;
  isBusy: boolean;
  discard: () => void | Promise<void>;
};

export type UnsavedFormSelection = "all" | readonly string[];

export type UnsavedFormRegistrationToken = Readonly<{
  id: string;
  instance: symbol;
}>;

export type UnsavedFormDiscardError = {
  entry: UnsavedFormEntry;
  error: unknown;
};

export type UnsavedFormDiscardResult = {
  ok: boolean;
  errors: UnsavedFormDiscardError[];
};

type StoredUnsavedFormEntry = {
  token: UnsavedFormRegistrationToken;
  entry: UnsavedFormEntry;
};

export function unsavedFormSnapshotsEqual(
  left: unknown,
  right: unknown
): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }

    return (
      left.length === right.length &&
      left.every((value, index) =>
        unsavedFormSnapshotsEqual(value, right[index])
      )
    );
  }

  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return leftKeys.every((key) =>
    unsavedFormSnapshotsEqual(leftRecord[key], rightRecord[key])
  );
}

function matchesSelection(
  entry: UnsavedFormEntry,
  selection: UnsavedFormSelection
) {
  return selection === "all" || selection.includes(entry.id);
}

export class UnsavedChangesRegistry {
  private readonly entries = new Map<string, StoredUnsavedFormEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRevision = () => this.revision;

  register(entry: UnsavedFormEntry): UnsavedFormRegistrationToken {
    const token = Object.freeze({
      id: entry.id,
      instance: Symbol(entry.id),
    });
    this.entries.set(entry.id, { token, entry });
    this.emit();
    return token;
  }

  update(
    token: UnsavedFormRegistrationToken,
    entry: UnsavedFormEntry
  ): boolean {
    const current = this.entries.get(token.id);
    if (
      !current ||
      current.token.instance !== token.instance ||
      entry.id !== token.id
    ) {
      return false;
    }

    this.entries.set(token.id, { token, entry });
    this.emit();
    return true;
  }

  unregister(token: UnsavedFormRegistrationToken): boolean {
    const current = this.entries.get(token.id);
    if (!current || current.token.instance !== token.instance) {
      return false;
    }

    this.entries.delete(token.id);
    this.emit();
    return true;
  }

  getEntries(selection: UnsavedFormSelection = "all"): UnsavedFormEntry[] {
    return Array.from(this.entries.values(), ({ entry }) => entry).filter(
      (entry) => matchesSelection(entry, selection)
    );
  }

  getDirtyEntries(
    selection: UnsavedFormSelection = "all"
  ): UnsavedFormEntry[] {
    return this.getEntries(selection).filter((entry) => entry.isDirty);
  }

  getBusyEntries(
    selection: UnsavedFormSelection = "all"
  ): UnsavedFormEntry[] {
    return this.getEntries(selection).filter((entry) => entry.isBusy);
  }

  async discardEntries(
    entries: readonly UnsavedFormEntry[]
  ): Promise<UnsavedFormDiscardResult> {
    const errors: UnsavedFormDiscardError[] = [];

    for (const entry of entries) {
      try {
        await entry.discard();
      } catch (error) {
        errors.push({ entry, error });
      }
    }

    return {
      ok: errors.length === 0,
      errors,
    };
  }

  private emit() {
    this.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
