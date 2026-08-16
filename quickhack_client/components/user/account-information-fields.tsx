"use client";

import * as React from "react";
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
  return (
    <>
      <AccountFieldLabel label="로그인 아이디">
        <Input
          value={value.username}
          placeholder="예: hong"
          autoComplete="username"
          disabled={disabled}
          onChange={(event) => onChange("username", event.target.value)}
        />
      </AccountFieldLabel>

      <AccountFieldLabel label="직원 표시 이름">
        <Input
          value={value.displayName}
          placeholder="예: 홍길동"
          autoComplete="name"
          disabled={disabled}
          onChange={(event) => onChange("displayName", event.target.value)}
        />
      </AccountFieldLabel>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AccountFieldLabel label="전화번호">
          <Input
            value={value.phone}
            placeholder="예: 010-0000-0000"
            inputMode="tel"
            autoComplete="tel"
            disabled={disabled}
            onChange={(event) => onChange("phone", event.target.value)}
          />
        </AccountFieldLabel>

        <AccountFieldLabel label="이메일">
          <Input
            type="email"
            value={value.email}
            placeholder="예: user@company.com"
            autoComplete="email"
            disabled={disabled}
            onChange={(event) => onChange("email", event.target.value)}
          />
        </AccountFieldLabel>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AccountFieldLabel label="생일">
          <Input
            type="date"
            value={value.birthDate}
            autoComplete="bday"
            disabled={disabled}
            onChange={(event) => onChange("birthDate", event.target.value)}
          />
        </AccountFieldLabel>

        <AccountFieldLabel label="입사일">
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
