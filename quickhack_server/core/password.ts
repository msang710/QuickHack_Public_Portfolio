// QuickHack note: 테스트/운영 계정 비밀번호 해시와 검증을 담당합니다.
﻿import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const LOGIN_DUMMY_PASSWORD_HASH =
  "scrypt$QSDhmHbGuKP45JcCGP8eiA$_5gl1yPKuEfxGLprG_Lgqkk5gW-uklwL3YTxKiXxSSjOnBU7nwOkbPI3SO_WXxkbdSKkxAsOp3eX8mbcPlmjew";

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;

  return `scrypt$${salt}$${Buffer.from(key).toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, encodedKey] = storedHash.split("$");

  if (algorithm !== "scrypt" || !salt || !encodedKey) {
    return false;
  }

  const storedKey = Buffer.from(encodedKey, "base64url");
  const candidateKey = Buffer.from(
    (await scryptAsync(password, salt, storedKey.length)) as Buffer
  );

  if (candidateKey.length !== storedKey.length) {
    return false;
  }

  return timingSafeEqual(candidateKey, storedKey);
}

function isUsableLoginPasswordHash(storedHash: string | null | undefined) {
  if (!storedHash) {
    return false;
  }

  const [algorithm, salt, encodedKey, extra] = storedHash.split("$");

  return Boolean(
    algorithm === "scrypt" &&
      salt &&
      encodedKey &&
      !extra &&
      /^[A-Za-z0-9_-]+$/.test(encodedKey) &&
      Buffer.from(encodedKey, "base64url").length === KEY_LENGTH
  );
}

export async function verifyLoginPassword(
  password: string,
  activeUserPasswordHash: string | null | undefined,
  verifier: typeof verifyPassword = verifyPassword
) {
  const hasUsableUserHash = isUsableLoginPasswordHash(
    activeUserPasswordHash
  );
  const passwordMatches = await verifier(
    password,
    hasUsableUserHash
      ? activeUserPasswordHash!
      : LOGIN_DUMMY_PASSWORD_HASH
  );

  return hasUsableUserHash && passwordMatches;
}
