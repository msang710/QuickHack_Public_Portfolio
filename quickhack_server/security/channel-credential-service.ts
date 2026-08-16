import { prisma } from "@/quickhack_server/core/prisma";
import type { ChannelAuthPublicStatus } from "@/quickhack_server/security/channel-auth";
import {
  formatKstSqlDateTime,
  parseKstSqlDateTime,
} from "@/quickhack_shared/core/time";

const ACTIVE_CREDENTIAL_STATUSES = ["ACTIVE", "WARNING"] as const;
const FALLBACK_KEY_ALIAS = "current";
type ChannelCredentialEventType =
  | "STATUS_SYNC"
  | "VALIDATION_SUCCEEDED"
  | "VALIDATION_FAILED"
  | "SUPERSEDED"
  | "EXPIRED"
  | "DISABLED";

type CredentialEventTx = Pick<typeof prisma, "$executeRaw">;

function nowText() {
  return formatKstSqlDateTime();
}

function storedKeyAlias(status: ChannelAuthPublicStatus) {
  return String(status.keyAlias || FALLBACK_KEY_ALIAS).trim() || FALLBACK_KEY_ALIAS;
}

function eventTypeForStatus(status: ChannelAuthPublicStatus): ChannelCredentialEventType {
  if (status.status === "EXPIRED") {
    return "EXPIRED";
  }

  if (status.status === "DISABLED" || status.status === "NOT_IMPLEMENTED") {
    return "DISABLED";
  }

  if (!status.readEnabled) {
    return "VALIDATION_FAILED";
  }

  if (status.status === "ACTIVE" || status.status === "WARNING") {
    return "VALIDATION_SUCCEEDED";
  }

  return "STATUS_SYNC";
}

async function recordCredentialEvent(input: {
  tx: CredentialEventTx;
  channelCredentialId: number | null;
  status: ChannelAuthPublicStatus;
  keyAlias: string;
  eventType: ChannelCredentialEventType;
  previousStatus: string | null;
  reason: string | null;
  occurredAt: string;
}) {
  await input.tx.$executeRaw`
    INSERT INTO channel_credential_events (
      channel_credential_id,
      channel,
      provider_type,
      key_alias,
      key_fingerprint,
      event_type,
      previous_status,
      new_status,
      read_enabled,
      write_enabled,
      reason,
      occurred_at
    ) VALUES (
      ${input.channelCredentialId},
      ${input.status.channel},
      ${input.status.providerType},
      ${input.keyAlias},
      ${input.status.keyFingerprint},
      ${input.eventType},
      ${input.previousStatus},
      ${input.status.status},
      ${input.status.readEnabled ? 1 : 0},
      ${input.status.writeEnabled ? 1 : 0},
      ${input.reason},
      ${input.occurredAt}
    )
  `;
}

function credentialChanged(
  existing: {
    key_fingerprint: string | null;
    expires_at: Date | null;
    credential_status: string;
    read_enabled: number;
    write_enabled: number;
    last_error_message: string | null;
  } | null,
  data: {
    key_fingerprint: string | null;
    expires_at: string | null;
    credential_status: string;
    read_enabled: number;
    write_enabled: number;
    last_error_message: string | null;
  }
) {
  return (
    !existing ||
    existing.key_fingerprint !== data.key_fingerprint ||
    (parseKstSqlDateTime(existing.expires_at)?.getTime() ?? null) !==
      (parseKstSqlDateTime(data.expires_at)?.getTime() ?? null) ||
    existing.credential_status !== data.credential_status ||
    existing.read_enabled !== data.read_enabled ||
    existing.write_enabled !== data.write_enabled ||
    existing.last_error_message !== data.last_error_message
  );
}

export async function persistChannelCredentialStatus(
  status: ChannelAuthPublicStatus
) {
  const keyAlias = storedKeyAlias(status);
  const now = nowText();
  const data = {
    channel: status.channel,
    provider_type: status.providerType,
    key_alias: keyAlias,
    key_fingerprint: status.keyFingerprint,
    expires_at: status.expiresAt,
    credential_status: status.status,
    read_enabled: status.readEnabled ? 1 : 0,
    write_enabled: status.writeEnabled ? 1 : 0,
    last_verified_at: status.lastVerifiedAt,
    last_error_message: status.errorMessage || status.warningMessage,
    updated_at: now,
  };

  return prisma.$transaction(async (tx) => {
    if (!status.readEnabled) {
      const activeRows = await tx.channel_credentials.findMany({
        where: {
          channel: status.channel,
          provider_type: status.providerType,
          credential_status: {
            in: [...ACTIVE_CREDENTIAL_STATUSES],
          },
        },
        select: {
          channel_credential_id: true,
          key_alias: true,
          credential_status: true,
        },
      });

      await tx.channel_credentials.updateMany({
        where: {
          channel: status.channel,
          provider_type: status.providerType,
          credential_status: {
            in: [...ACTIVE_CREDENTIAL_STATUSES],
          },
        },
        data: {
          credential_status: status.status,
          read_enabled: 0,
          write_enabled: 0,
          last_error_message:
            status.errorMessage || status.warningMessage || "Credential is not readable.",
          updated_at: now,
        },
      });

      for (const row of activeRows) {
        await recordCredentialEvent({
          tx,
          channelCredentialId: row.channel_credential_id,
          status,
          keyAlias: row.key_alias || keyAlias,
          eventType: eventTypeForStatus(status),
          previousStatus: row.credential_status,
          reason:
            status.errorMessage || status.warningMessage || "Credential is not readable.",
          occurredAt: now,
        });
      }
    }

    if (
      status.keyAlias &&
      status.keyFingerprint &&
      ACTIVE_CREDENTIAL_STATUSES.includes(
        status.status as (typeof ACTIVE_CREDENTIAL_STATUSES)[number]
      )
    ) {
      const supersededRows = await tx.channel_credentials.findMany({
        where: {
          channel: status.channel,
          provider_type: status.providerType,
          key_alias: {
            not: keyAlias,
          },
          credential_status: {
            in: [...ACTIVE_CREDENTIAL_STATUSES],
          },
        },
        select: {
          channel_credential_id: true,
          key_alias: true,
          credential_status: true,
        },
      });

      await tx.channel_credentials.updateMany({
        where: {
          channel: status.channel,
          provider_type: status.providerType,
          key_alias: {
            not: keyAlias,
          },
          credential_status: {
            in: [...ACTIVE_CREDENTIAL_STATUSES],
          },
        },
        data: {
          credential_status: "DISABLED",
          read_enabled: 0,
          write_enabled: 0,
          last_error_message: `Superseded by credential ${keyAlias}.`,
          updated_at: now,
        },
      });

      for (const row of supersededRows) {
        await recordCredentialEvent({
          tx,
          channelCredentialId: row.channel_credential_id,
          status: {
            ...status,
            status: "DISABLED",
            readEnabled: false,
            writeEnabled: false,
            errorMessage: `Superseded by credential ${keyAlias}.`,
          },
          keyAlias: row.key_alias || FALLBACK_KEY_ALIAS,
          eventType: "SUPERSEDED",
          previousStatus: row.credential_status,
          reason: `Superseded by credential ${keyAlias}.`,
          occurredAt: now,
        });
      }
    }

    const existing = await tx.channel_credentials.findFirst({
      where: {
        channel: status.channel,
        provider_type: status.providerType,
        key_alias: keyAlias,
      },
      select: {
        channel_credential_id: true,
        key_fingerprint: true,
        expires_at: true,
        credential_status: true,
        read_enabled: true,
        write_enabled: true,
        last_error_message: true,
      },
    });
    const changed = credentialChanged(existing, data);
    const saved = existing
      ? await tx.channel_credentials.update({
          where: {
            channel_credential_id: existing.channel_credential_id,
          },
          data,
        })
      : await tx.channel_credentials.create({
          data,
        });

    if (changed) {
      await recordCredentialEvent({
        tx,
        channelCredentialId: saved.channel_credential_id,
        status,
        keyAlias,
        eventType: eventTypeForStatus(status),
        previousStatus: existing?.credential_status ?? null,
        reason: status.errorMessage || status.warningMessage || null,
        occurredAt: now,
      });
    }

    return saved;
  });
}
