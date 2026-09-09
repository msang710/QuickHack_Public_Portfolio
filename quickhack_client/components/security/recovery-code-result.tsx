"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";
import { useUnsavedForm } from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Button } from "@/quickhack_client/components/ui/button";
import { oneTimeResultIsPending } from "@/quickhack_client/components/user/mobile-registration-draft-state";

export function useOneTimeRecoveryCodes(input: { formId: string; label: string }) {
  const [codes, setCodesState] = React.useState<string[]>([]);
  const [acknowledged, setAcknowledged] = React.useState(true);
  const discard = React.useCallback(() => {
    setCodesState([]);
    setAcknowledged(true);
  }, []);
  const setCodes = React.useCallback((nextCodes: string[]) => {
    setCodesState(nextCodes);
    setAcknowledged(nextCodes.length === 0);
  }, []);

  useUnsavedForm({
    id: input.formId,
    label: input.label,
    kind: "one-time-result",
    isDirty: oneTimeResultIsPending(codes, acknowledged),
    discard,
  });

  return { codes, acknowledged, setCodes, acknowledge: () => setAcknowledged(true), discard };
}

export function RecoveryCodeResult({
  codes,
  acknowledged,
  onAcknowledge,
}: {
  codes: string[];
  acknowledged: boolean;
  onAcknowledge: () => void;
}) {
  const t = useTranslations("common.recoveryCodes");
  if (codes.length === 0) return null;
  return (
    <div className="grid gap-2 border-t border-amber-200 bg-amber-50 p-3 text-amber-900">
      <div className="text-xs font-semibold">
        {t("warning")}
      </div>
      <div className="grid grid-cols-2 gap-1 font-mono text-xs sm:grid-cols-4">
        {codes.map((code) => (
          <div key={code} className="border bg-white px-2 py-1">{code}</div>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="justify-self-start border-amber-300 bg-white"
        disabled={acknowledged}
        onClick={onAcknowledge}
      >
        <CheckCircle2 className="size-4" />
        {acknowledged ? t("stored") : t("store")}
      </Button>
    </div>
  );
}
