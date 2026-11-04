import { safeStorage } from 'electron';

const CIPHER_PREFIX = 'enc:v1:';

/** 是否已是 safeStorage 密文（幂等加密用）。 */
export function isEncryptedApiKey(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(CIPHER_PREFIX);
}

/**
 * 加密 API Key：已是密文则原样返回；平台可用时用 safeStorage 加密为 base64。
 * 平台不可用时返回空串，保证 settings.json 不落明文。
 */
export function encryptApiKey(plain: string | undefined | null): string {
  const text = typeof plain === 'string' ? plain.trim() : '';
  if (!text) return '';
  if (isEncryptedApiKey(text)) return text;
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[ai] safeStorage 不可用，API Key 未落盘（避免明文）');
      return '';
    }
    return `${CIPHER_PREFIX}${safeStorage.encryptString(text).toString('base64')}`;
  } catch (error) {
    console.warn(`[ai] API Key 加密失败：${(error as Error).message}`);
    return '';
  }
}

/** 解密 API Key：兼容历史明文；解密失败返回空串。 */
export function decryptApiKey(stored: string | undefined | null): string {
  const value = typeof stored === 'string' ? stored.trim() : '';
  if (!value) return '';
  if (!isEncryptedApiKey(value)) return value;
  try {
    const buffer = Buffer.from(value.slice(CIPHER_PREFIX.length), 'base64');
    return safeStorage.decryptString(buffer);
  } catch (error) {
    console.warn(`[ai] API Key 解密失败：${(error as Error).message}`);
    return '';
  }
}
