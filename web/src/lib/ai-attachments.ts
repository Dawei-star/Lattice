export type AiAttachmentKind = 'image' | 'file';

export interface AiAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: AiAttachmentKind;
  dataUrl: string;
}

export interface AiAttachmentDraft extends Omit<AiAttachment, 'dataUrl'> {
  file: File;
}

export interface AiAttachmentLimits {
  maxCount?: number;
  maxImageBytes?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export const AI_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 4,
  maxImageBytes: 10 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
});

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/rtf',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
]);
const FILE_TYPES = new Set([...IMAGE_TYPES, ...TEXT_TYPES, 'application/pdf']);

export function normalizeAiMimeType(value: unknown, fileName = ''): string {
  const explicit = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  if (explicit && explicit !== 'application/octet-stream') return explicit === 'image/jpg' ? 'image/jpeg' : explicit;
  const extension = String(fileName).toLowerCase().split('.').pop();
  const inferred = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'png' ? 'image/png'
      : extension === 'webp' ? 'image/webp'
        : extension === 'gif' ? 'image/gif'
          : extension === 'avif' ? 'image/avif'
            : extension === 'md' ? 'text/markdown'
              : extension === 'txt' ? 'text/plain'
                : extension === 'csv' ? 'text/csv'
                  : extension === 'json' ? 'application/json'
                    : extension === 'pdf' ? 'application/pdf'
                      : '';
  return inferred || explicit || 'application/octet-stream';
}

export function attachmentKindForType(type: string): AiAttachmentKind {
  return type.startsWith('image/') ? 'image' : 'file';
}

export function validateAiAttachment(file: File, existing: AiAttachment[] = [], limits: AiAttachmentLimits = AI_ATTACHMENT_LIMITS): string | null {
  if (!file || !file.name) return '请选择一个文件';
  const type = normalizeAiMimeType(file.type, file.name);
  if (!FILE_TYPES.has(type)) return '暂不支持此文件类型，请选择图片、PDF、Markdown、文本、CSV 或 JSON 文件';
  const maxCount = limits.maxCount ?? AI_ATTACHMENT_LIMITS.maxCount;
  if (existing.length >= maxCount) return `一次最多添加 ${maxCount} 个文件`;
  const maxBytes = type.startsWith('image/')
    ? (limits.maxImageBytes ?? AI_ATTACHMENT_LIMITS.maxImageBytes)
    : (limits.maxFileBytes ?? AI_ATTACHMENT_LIMITS.maxFileBytes);
  if (file.size > maxBytes) return `${type.startsWith('image/') ? '图片' : '文件'}不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`;
  const total = existing.reduce((sum, item) => sum + item.size, 0) + file.size;
  const maxTotal = limits.maxTotalBytes ?? AI_ATTACHMENT_LIMITS.maxTotalBytes;
  if (total > maxTotal) return `附件总大小不能超过 ${Math.round(maxTotal / 1024 / 1024)} MB`;
  return null;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
    reader.readAsDataURL(file);
  });
}

export async function createAiAttachment(file: File, index = 0): Promise<AiAttachment> {
  const type = normalizeAiMimeType(file.type, file.name);
  return {
    id: `ai-attachment-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    type,
    size: file.size,
    kind: attachmentKindForType(type),
    dataUrl: await readFileAsDataUrl(file),
  };
}

export interface AiChatRequestInput {
  message: string;
  attachments?: AiAttachment[];
  [key: string]: unknown;
}

/** Keep the existing text contract and add a provider-neutral multimodal field. */
export function buildAiChatRequest<T extends AiChatRequestInput>(input: T): T & { attachments?: Array<Omit<AiAttachment, 'id'>> } {
  const attachments = (input.attachments ?? []).map(({ id: _id, ...attachment }) => attachment);
  return attachments.length ? { ...input, attachments } : { ...input, attachments: undefined };
}

export function formatAiAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
