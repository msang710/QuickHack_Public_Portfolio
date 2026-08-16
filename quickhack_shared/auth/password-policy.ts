// QuickHack note: 관리자 임시 비밀번호와 본인 비밀번호 변경이 같은 최소 정책을 사용합니다.
export const PASSWORD_MIN_LENGTH = 8;

export function passwordLengthError(
  password: string,
  label = "비밀번호"
) {
  return password.length < PASSWORD_MIN_LENGTH
    ? `${label}는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`
    : "";
}

export function passwordChangeValidationError(input: {
  currentPassword: string;
  newPassword: string;
  newPasswordConfirm: string;
}) {
  if (!input.currentPassword) {
    return "현재 비밀번호를 입력하세요.";
  }

  const lengthError = passwordLengthError(input.newPassword, "새 비밀번호");

  if (lengthError) {
    return lengthError;
  }

  if (input.newPassword !== input.newPasswordConfirm) {
    return "새 비밀번호 확인이 일치하지 않습니다.";
  }

  if (input.newPassword === input.currentPassword) {
    return "현재 비밀번호와 다른 새 비밀번호를 입력하세요.";
  }

  return "";
}
