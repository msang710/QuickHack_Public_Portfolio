import { prisma } from "@/quickhack_server/core/prisma";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

export const LOGEN_CARRIER_CODE = "LOGEN" as const;

type SettingsRow = {
  carrier_code: string;
  sender_name: string;
  sender_tel: string;
  sender_cell: string | null;
  sender_zip_code: string | null;
  sender_address_1: string;
  sender_address_2: string;
  default_box_type_code: string;
  revision: number;
  updated_at: Date;
};

export type LogenIntegrationSettings = {
  configured: true;
  carrierCode: typeof LOGEN_CARRIER_CODE;
  sender: {
    name: string;
    tel: string;
    cell: string;
    zipCode: string;
    address1: string;
    address2: string;
  };
  defaultBoxTypeCode: string;
  revision: number;
  updatedAt: string;
};

export type EmptyLogenIntegrationSettings = {
  configured: false;
  carrierCode: typeof LOGEN_CARRIER_CODE;
  revision: 0;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function requiredText(value: unknown, fieldName: string) {
  const normalized = text(value);
  if (!normalized) {
    throw publicBadRequest(
      "LOGEN_INTEGRATION_SETTING_REQUIRED",
      `택배사 발송 설정의 ${fieldName} 항목을 입력하세요.`,
      { fieldName }
    );
  }
  return normalized;
}

function expectedRevision(value: unknown) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw publicBadRequest(
      "LOGEN_INTEGRATION_SETTING_REVISION_INVALID",
      "택배사 발송 설정의 버전 값이 올바르지 않습니다."
    );
  }
  return revision;
}

function toDto(row: SettingsRow): LogenIntegrationSettings {
  return {
    configured: true,
    carrierCode: LOGEN_CARRIER_CODE,
    sender: {
      name: row.sender_name,
      tel: row.sender_tel,
      cell: row.sender_cell ?? "",
      zipCode: row.sender_zip_code ?? "",
      address1: row.sender_address_1,
      address2: row.sender_address_2,
    },
    defaultBoxTypeCode: row.default_box_type_code,
    revision: row.revision,
    updatedAt: requiredApiDateTime(row.updated_at),
  };
}

export async function getLogenIntegrationSettings(
  client: Pick<typeof prisma, "carrier_integration_settings"> = prisma
): Promise<LogenIntegrationSettings | EmptyLogenIntegrationSettings> {
  const row = await client.carrier_integration_settings.findUnique({
    where: { carrier_code: LOGEN_CARRIER_CODE },
  });

  return row
    ? toDto(row)
    : {
        configured: false,
        carrierCode: LOGEN_CARRIER_CODE,
        revision: 0,
      };
}

export async function requireLogenIntegrationSettings(
  client: Pick<typeof prisma, "carrier_integration_settings"> = prisma
) {
  const settings = await getLogenIntegrationSettings(client);
  if (!settings.configured) {
    throw publicConflict(
      "LOGEN_INTEGRATION_SETTINGS_REQUIRED",
      "택배사 발송 설정이 등록되지 않아 로젠 송장 등록을 진행할 수 없습니다. 송장 관리의 택배사 발송 설정에서 먼저 등록하세요."
    );
  }
  return settings;
}

export async function saveLogenIntegrationSettings(
  input: Record<string, unknown>,
  actor: { userId: number }
) {
  const senderInput =
    input.sender && typeof input.sender === "object" && !Array.isArray(input.sender)
      ? (input.sender as Record<string, unknown>)
      : {};
  const revision = expectedRevision(input.expectedRevision);
  const normalized = {
    sender_name: requiredText(senderInput.name, "보내는 분 이름"),
    sender_tel: requiredText(senderInput.tel, "보내는 분 전화번호"),
    sender_cell: text(senderInput.cell) || null,
    sender_zip_code: text(senderInput.zipCode) || null,
    sender_address_1: requiredText(senderInput.address1, "보내는 분 주소"),
    sender_address_2: requiredText(senderInput.address2, "보내는 분 상세주소"),
    default_box_type_code: requiredText(
      input.defaultBoxTypeCode,
      "기본 박스 유형 코드"
    ),
  };
  const timestamp = databaseNow();

  return prisma.$transaction(async (tx) => {
    const before = await tx.carrier_integration_settings.findUnique({
      where: { carrier_code: LOGEN_CARRIER_CODE },
    });

    if ((before?.revision ?? 0) !== revision) {
      throw publicConflict(
        "LOGEN_INTEGRATION_SETTINGS_STALE",
        "다른 작업자가 택배사 발송 설정을 먼저 변경했습니다. 최신 설정을 다시 불러온 뒤 저장하세요.",
        { expectedRevision: revision, currentRevision: before?.revision ?? 0 }
      );
    }

    let after: SettingsRow;
    if (!before) {
      const inserted = await tx.$queryRaw<SettingsRow[]>`
        INSERT INTO carrier_integration_settings (
          carrier_code,
          sender_name,
          sender_tel,
          sender_cell,
          sender_zip_code,
          sender_address_1,
          sender_address_2,
          default_box_type_code,
          revision,
          updated_by_user_id,
          created_at,
          updated_at
        ) VALUES (
          ${LOGEN_CARRIER_CODE},
          ${normalized.sender_name},
          ${normalized.sender_tel},
          ${normalized.sender_cell},
          ${normalized.sender_zip_code},
          ${normalized.sender_address_1},
          ${normalized.sender_address_2},
          ${normalized.default_box_type_code},
          1,
          ${actor.userId},
          ${timestamp},
          ${timestamp}
        )
        ON CONFLICT (carrier_code) DO NOTHING
        RETURNING
          carrier_code,
          sender_name,
          sender_tel,
          sender_cell,
          sender_zip_code,
          sender_address_1,
          sender_address_2,
          default_box_type_code,
          revision,
          updated_at
      `;
      if (!inserted[0]) {
        throw publicConflict(
          "LOGEN_INTEGRATION_SETTINGS_STALE",
          "다른 작업자가 로젠 발송 설정을 먼저 등록했습니다. 최신 설정을 다시 불러와 수정하세요.",
          { expectedRevision: 0 }
        );
      }
      after = inserted[0];
    } else {
      const updated = await tx.carrier_integration_settings.updateMany({
        where: {
          carrier_integration_setting_id:
            before.carrier_integration_setting_id,
          revision,
        },
        data: {
          ...normalized,
          revision: { increment: 1 },
          updated_by_user_id: actor.userId,
          updated_at: timestamp,
        },
      });

      if (updated.count !== 1) {
        throw publicConflict(
          "LOGEN_INTEGRATION_SETTINGS_STALE",
          "다른 작업자가 택배사 발송 설정을 먼저 변경했습니다. 최신 설정을 다시 불러온 뒤 저장하세요."
        );
      }

      after = await tx.carrier_integration_settings.findUniqueOrThrow({
        where: { carrier_code: LOGEN_CARRIER_CODE },
      });
    }

    const beforeDto = before ? toDto(before) : null;
    const afterDto = toDto(after);
    await tx.employee_activity_logs.create({
      data: {
        user_id: actor.userId,
        action_type: "LOGEN_INTEGRATION_SETTINGS_UPDATE",
        target_type: "CARRIER_INTEGRATION_SETTINGS",
        target_id: LOGEN_CARRIER_CODE,
        ...activityLogChangeData(beforeDto, afterDto),
        result: "SUCCESS",
        created_at: timestamp,
      },
    });

    return afterDto;
  });
}
