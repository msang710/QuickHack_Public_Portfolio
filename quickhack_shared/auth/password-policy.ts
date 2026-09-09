// QuickHack note: 관리자 임시 비밀번호와 본인 비밀번호 변경이 같은 최소 정책을 사용합니다.
export const PASSWORD_MIN_LENGTH = 8;

export type PasswordChangeValidationIssue =
  | "CURRENT_PASSWORD_REQUIRED"
  | "NEW_PASSWORD_TOO_SHORT"
  | "NEW_PASSWORD_CONFIRM_MISMATCH"
  | "NEW_PASSWORD_UNCHANGED";

export function passwordChangeValidationIssue(input: {
  currentPassword: string;
  newPassword: string;
  newPasswordConfirm: string;
}): PasswordChangeValidationIssue | null {
  if (!input.currentPassword) return "CURRENT_PASSWORD_REQUIRED";
  if (input.newPassword.length < PASSWORD_MIN_LENGTH) return "NEW_PASSWORD_TOO_SHORT";
  if (input.newPassword !== input.newPasswordConfirm) return "NEW_PASSWORD_CONFIRM_MISMATCH";
  if (input.newPassword === input.currentPassword) return "NEW_PASSWORD_UNCHANGED";
  return null;
}
