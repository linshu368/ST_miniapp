export const USER_INPUT_MARKER = 'st_user_input';

export type UserInputExtractionIssue =
  | 'marker_missing'
  | 'marker_duplicated'
  | 'marked_message_invalid';

export interface UserInputExtractionResult {
  messages: unknown[];
  userInput: string;
  issue: UserInputExtractionIssue | null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function extractMarkedUserInput(messages: unknown[]): UserInputExtractionResult {
  const markedMessages: Array<Record<string, unknown>> = [];
  const sanitizedMessages = messages.map((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;

    const record = message as Record<string, unknown>;
    if (record[USER_INPUT_MARKER] === true) markedMessages.push(record);

    const sanitized = { ...record };
    delete sanitized[USER_INPUT_MARKER];
    return sanitized;
  });

  if (markedMessages.length === 0) {
    return { messages: sanitizedMessages, userInput: '', issue: 'marker_missing' };
  }
  if (markedMessages.length > 1) {
    return { messages: sanitizedMessages, userInput: '', issue: 'marker_duplicated' };
  }

  const markedMessage = markedMessages[0]!;
  const userInput = markedMessage.role === 'user' ? extractTextContent(markedMessage.content) : '';
  if (!userInput) {
    return { messages: sanitizedMessages, userInput: '', issue: 'marked_message_invalid' };
  }

  return { messages: sanitizedMessages, userInput, issue: null };
}
