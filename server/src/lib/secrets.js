import { timingSafeEqual } from 'node:crypto';

/**
 * 恒定时间比较：令牌/密钥校验必须用它，普通 === 比较会通过耗时侧信道泄露前缀。
 * 先比长度是因为 timingSafeEqual 只接受等长 Buffer（长度本身不算机密）。
 */
export function sameSecret(candidate, expected) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}
