// QuickHack note: 송장 관리에서 택배사 발송자와 기본 포장 설정을 관리합니다.
"use client";

import * as React from "react";
import { RefreshCcw, Save, Truck } from "lucide-react";
import { verifySensitiveOtpCode } from "@/quickhack_client/auth/sensitive-request";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import { SENSITIVE_ACTIONS } from "@/quickhack_shared/auth/sensitive-auth";

type CarrierDispatchSettings = {
  configured: boolean;
  carrierCode: "LOGEN";
  sender?: {
    name: string;
    tel: string;
    cell: string;
    zipCode: string;
    address1: string;
    address2: string;
  };
  defaultBoxTypeCode?: string;
  revision: number;
  updatedAt?: string;
};

type CarrierDispatchSettingsForm = {
  name: string;
  tel: string;
  cell: string;
  zipCode: string;
  address1: string;
  address2: string;
  defaultBoxTypeCode: string;
};

const EMPTY_FORM: CarrierDispatchSettingsForm = {
  name: "",
  tel: "",
  cell: "",
  zipCode: "",
  address1: "",
  address2: "",
  defaultBoxTypeCode: "",
};

const FORM_FIELDS = [
  { key: "name", label: "보내는 분 이름" },
  { key: "tel", label: "전화번호" },
  { key: "cell", label: "휴대전화(선택)" },
  { key: "zipCode", label: "우편번호(선택)" },
  { key: "address1", label: "주소" },
  { key: "address2", label: "상세주소" },
  { key: "defaultBoxTypeCode", label: "기본 박스 유형 코드" },
] as const satisfies ReadonlyArray<{
  key: keyof CarrierDispatchSettingsForm;
  label: string;
}>;

export function CarrierDispatchSettingsView() {
  const [revision, setRevision] = React.useState(0);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [otpCode, setOtpCode] = React.useState("");
  const [message, setMessage] = React.useState(
    "택배사 발송 설정을 불러오는 중입니다."
  );
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  function applySettings(item: CarrierDispatchSettings) {
    setRevision(item.revision);
    setForm({
      name: item.sender?.name ?? "",
      tel: item.sender?.tel ?? "",
      cell: item.sender?.cell ?? "",
      zipCode: item.sender?.zipCode ?? "",
      address1: item.sender?.address1 ?? "",
      address2: item.sender?.address2 ?? "",
      defaultBoxTypeCode: item.defaultBoxTypeCode ?? "",
    });
    setMessage(
      item.configured
        ? `저장된 택배사 발송 설정입니다. 리비전 ${item.revision}`
        : "아직 택배사 발송 설정이 없습니다. 로젠 송장 등록 전에 최초 설정을 저장하세요."
    );
  }

  async function loadSettings() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/carrier-integration-settings", {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        item?: CarrierDispatchSettings;
      };
      if (!response.ok || !payload.ok || !payload.item) {
        throw new Error(payload.message || "택배사 발송 설정을 불러오지 못했습니다.");
      }
      applySettings(payload.item);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    try {
      if (otpCode.trim()) {
        await verifySensitiveOtpCode(
          otpCode.trim(),
          SENSITIVE_ACTIONS.carrierIntegrationSettings
        );
      }
      const response = await fetch("/api/admin/carrier-integration-settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sender: {
            name: form.name,
            tel: form.tel,
            cell: form.cell,
            zipCode: form.zipCode,
            address1: form.address1,
            address2: form.address2,
          },
          defaultBoxTypeCode: form.defaultBoxTypeCode,
          expectedRevision: revision,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        sensitiveAuthRequired?: boolean;
        item?: CarrierDispatchSettings;
      };
      if (!response.ok || !payload.ok || !payload.item) {
        const suffix = payload.sensitiveAuthRequired
          ? " OTP 코드를 입력하고 다시 저장하세요."
          : "";
        throw new Error(
          (payload.message || "택배사 발송 설정을 저장하지 못했습니다.") + suffix
        );
      }
      applySettings(payload.item);
      setOtpCode("");
      setMessage(`택배사 발송 설정을 저장했습니다. 리비전 ${payload.item.revision}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => window.clearTimeout(timerId);
  }, []);

  const busy = loading || saving;

  return (
    <section className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 overflow-auto p-5">
      <section className="rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Truck className="size-4 text-primary" />
              택배사 발송 설정
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              로젠 송장 등록에 사용할 보내는 분 정보와 기본 박스 유형을 관리합니다.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void loadSettings()}
          >
            <RefreshCcw className="size-4" />
            최신 설정 다시 불러오기
          </Button>
        </div>

        <div className="grid gap-4 p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {FORM_FIELDS.map(({ key, label }) => (
              <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                {label}
                <Input
                  value={form[key]}
                  disabled={busy}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <label className="grid w-48 gap-1 text-xs text-muted-foreground">
              OTP 코드
              <Input
                value={otpCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                disabled={busy}
                onChange={(event) => setOtpCode(event.target.value)}
              />
            </label>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void saveSettings()}
            >
              <Save className="size-4" />
              {saving ? "저장 중" : "택배사 발송 설정 저장"}
            </Button>
          </div>
        </div>
      </section>
    </section>
  );
}
