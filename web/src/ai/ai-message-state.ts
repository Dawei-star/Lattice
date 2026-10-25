export interface AiMessageStateItem {
  id: string;
}

export function appendAiMessage<T extends AiMessageStateItem>(current: T[], message: T, welcomeMessageId: string) {
  return [...current.filter((item) => item.id !== welcomeMessageId), message];
}

export function restoreAiMessages<T extends AiMessageStateItem>(current: T[], restored: T[], welcomeMessage: T) {
  const hasRealMessages = current.some((item) => item.id !== welcomeMessage.id);
  if (hasRealMessages) return current;
  return restored.length ? restored : [welcomeMessage];
}

/**
 * 变体切换（U3，会话内存）：重新生成不丢弃旧回答——旧回答进变体组，
 * 新回答为当前显示版本。组内按时间序排列（旧 → 新），variantIndex 指向显示版本。
 * variants 只存在于会话内存中的消息对象，不写入持久化会话。
 */
export function attachRegenerateVariant<T>(previousVariants: readonly T[] | undefined, replaced: T, fresh: T): { variants: T[]; variantIndex: number } {
  const previous = previousVariants ?? [];
  // 重复生成链：replaced 已是组内最新一项（显示体在组内），只追加新版本避免重复
  const group = previous.length && previous[previous.length - 1] === replaced
    ? [...previous, fresh]
    : [...previous, replaced, fresh];
  return { variants: group, variantIndex: group.length - 1 };
}

/** 切到组内第 index 个版本：返回以该版本为显示体的新消息对象（组共享引用）。 */
export function switchMessageVariant<T>(variants: readonly T[], index: number): (T & { variants: T[]; variantIndex: number }) | null {
  const displayed = variants[index];
  if (!displayed) return null;
  return { ...displayed, variants: [...variants], variantIndex: index };
}
