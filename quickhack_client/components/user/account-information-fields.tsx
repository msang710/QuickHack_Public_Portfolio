"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/quickhack_client/components/ui/input";

export type EditableAccountInformation = {
  username: string;
  displayName: string;
  phone: string;
  email: string;
  birthDate: string;
  hireDate: string;
};

type AccountInformationFieldsProps = {
  value: EditableAccountInformation;
  disabled?: boolean;
  onChange: <K extends keyof EditableAccountInformation>(
    key: K,
    value: EditableAccountInformation[K]
  ) => void;
};

export function AccountFieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

export function AccountInformationFields({
  value,
  disabled = false,
  onChange,
}: AccountInformationFieldsProps) {
  const t = useTranslations("common.accountFields");
  return (
    <>
      <AccountFieldLabel label={t("username")}>
        <Input
          value={value.username}
          placeholder={t("usernamePlaceholder")}
          autoComplete="username"
          disabled={disabled}
          onChange={(event) => onChange("username", event.target.value)}
        />
      </AccountFieldLabel>

      <AccountFieldLabel label={t("displayName")}>
        <Input
          value={value.displayName}
          placeholder={t("displayNamePlaceholder")}
          autoComplete="name"
          disabled={disabled}
          onChange={(event) => onChange("displayName", event.target.value)}
        />
      </AccountFieldLabel>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AccountFieldLabel label={t("phone")}>
          <Input
            value={value.phone}
            placeholder={t("phonePlaceholder")}
            inputMode="tel"
            autoComplete="tel"
            disabled={disabled}
            onChange={(event) => onChange("phone", event.target.value)}
          />
        </AccountFieldLabel>

        <AccountFieldLabel label={t("email")}>
          <Input
            type="email"
            value={value.email}
            placeholder={t("emailPlaceholder")}
            autoComplete="email"
            disabled={disabled}
            onChange={(event) => onChange("email", event.target.value)}
          />
        </AccountFieldLabel>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AccountFieldLabel label={t("birthDate")}>
          <Input
            type="date"
            value={value.birthDate}
            autoComplete="bday"
            disabled={disabled}
            onChange={(event) => onChange("birthDate", event.target.value)}
          />
        </AccountFieldLabel>

        <AccountFieldLabel label={t("hireDate")}>
          <Input
            type="date"
            value={value.hireDate}
            disabled={disabled}
            onChange={(event) => onChange("hireDate", event.target.value)}
          />
        </AccountFieldLabel>
      </div>
    </>
  );
}
