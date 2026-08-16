// QuickHack note: 테스트 계정 비밀번호 해시 생성과 검증을 확인하는 도구입니다.
import { promisify } from "node:util";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = await scryptAsync(password, salt, KEY_LENGTH);

  return `scrypt$${salt}$${Buffer.from(key).toString("base64url")}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, salt, encodedKey] = String(storedHash || "").split("$");

  if (algorithm !== "scrypt" || !salt || !encodedKey) {
    return false;
  }

  const storedKey = Buffer.from(encodedKey, "base64url");
  const candidateKey = Buffer.from(
    await scryptAsync(password, salt, storedKey.length)
  );

  if (candidateKey.length !== storedKey.length) {
    return false;
  }

  return timingSafeEqual(candidateKey, storedKey);
}
