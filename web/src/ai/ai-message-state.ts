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
