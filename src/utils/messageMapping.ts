import type { BaseMessage } from "@langchain/core/messages";
import {
  mapChatMessagesToStoredMessages as coreMapChatMessagesToStoredMessages,
  mapStoredMessageToChatMessage as coreMapStoredMessageToChatMessage,
  mapStoredMessagesToChatMessages as coreMapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import type { StoredMessage } from "../queues/types.js";

/** Matches @langchain/langgraph REMOVE_ALL_MESSAGES; tells messagesStateReducer to replace all messages with those following this marker. */
export const REMOVE_ALL_MESSAGES = "__remove_all__";

/** LangChain's StoredMessage is structurally compatible for our serialized format; we cast for typing. */
const toCoreStored = (m: StoredMessage) => m as Parameters<typeof coreMapStoredMessageToChatMessage>[0];
const fromCoreStored = (m: ReturnType<typeof coreMapChatMessagesToStoredMessages>[number]) =>
  m as StoredMessage;

/**
 * Converts a single stored message (our type) to a BaseMessage.
 * Wrapper around @langchain/core mapStoredMessageToChatMessage.
 */
export function mapStoredMessageToChatMessage(stored: StoredMessage): BaseMessage {
  return coreMapStoredMessageToChatMessage(toCoreStored(stored));
}

/**
 * Converts an array of stored messages (our type) to BaseMessage[].
 * Wrapper around @langchain/core mapStoredMessagesToChatMessages.
 */
export function mapStoredMessagesToChatMessages(stored: StoredMessage[]): BaseMessage[] {
  return coreMapStoredMessagesToChatMessages(stored.map(toCoreStored));
}

/**
 * Converts BaseMessage[] to our StoredMessage[] for storage/serialization.
 * Wrapper around @langchain/core mapChatMessagesToStoredMessages.
 */
export function mapChatMessagesToStoredMessages(messages: BaseMessage[]): StoredMessage[] {
  return coreMapChatMessagesToStoredMessages(messages).map(fromCoreStored);
}

/**
 * Converts BaseMessage to our StoredMessage for storage/serialization.
 */
export function mapChatMessagesToStoredMessage(messages: BaseMessage): StoredMessage {
  const [storedMessage] = coreMapChatMessagesToStoredMessages([messages]);
  return fromCoreStored(storedMessage);
}
