/**
 * The model port — an engine-internal seam (core-blueprint.md §11.1).
 *
 * This port works in LangChain types: the use-case layer may depend on
 * LangChain (§1 rule 4), and the engine hands the port a `BaseChatModel`. No
 * LangChain type crosses the facade. Full streaming/usage specifics live in the
 * adapter (§11.4); the engine binds `chatModel()` to `createDeepAgent`.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface ResolvedModel {
  name: string;
  model: string;
  protocol: string;
  baseUrl?: string;
  contextLimit: number;
  maxOutputTokens?: number;
  vision: boolean;
}

export interface ModelInfo {
  name: string;
  model: string;
  protocol: string;
  active: boolean;
  /**
   * The endpoint's configured `baseUrl`, verbatim, when the entry sets one — a
   * read-only field a client uses to show WHICH endpoint a model failure came
   * from (`host[:port]`). Omitted for an entry with no `baseUrl` (a bundled
   * cloud default). Never carries credentials: `baseUrl` is a plain URL, and the
   * apiKey/apiKeyEnv never appears on this DTO.
   */
  baseUrl?: string;
}

export interface ModelPort {
  /** Resolve the active endpoint from the cascade; throws CoreError when unconfigured. */
  resolve(): ResolvedModel;
  /** The bound LangChain client for the engine. */
  chatModel(): BaseChatModel;
  /** Configured endpoints. */
  list(): ModelInfo[];
  /** Set the active endpoint. */
  switch(name: string): ResolvedModel;
  /**
   * Build a FRESH (uncached) client for the active endpoint, for passive
   * off-turn calls like the session auto-namer (§5.5, §11.6) that must not share
   * the one cached interactive client.
   */
  transientChatModel(): import("@langchain/core/language_models/chat_models").BaseChatModel;
}
