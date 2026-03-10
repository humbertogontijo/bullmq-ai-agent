/**
 * Wrapper around langchain's initChatModel that handles a bug in langchain's
 * error handling when a model provider package is missing.
 *
 * Langchain's getChatModelByClassName parses ERR_MODULE_NOT_FOUND messages
 * by splitting on "Cannot find package '". Node can emit different message
 * formats (e.g. "Cannot find module '...'"), so [1] is undefined and calling
 * .split on it throws: "undefined is not an object (evaluating '...split')".
 * This wrapper catches that and throws a clear, actionable error instead.
 */
import { initChatModel as langchainInitChatModel } from "langchain";

/** Known provider -> npm package for install hint when import fails. */
const PROVIDER_PACKAGES: Record<string, string> = {
  openai: "@langchain/openai",
  anthropic: "@langchain/anthropic",
  azure_openai: "@langchain/openai",
  cohere: "@langchain/cohere",
  "google-vertexai": "@langchain/google-vertexai",
  "google-vertexai-web": "@langchain/google-vertexai-web",
  "google-genai": "@langchain/google-genai",
  ollama: "@langchain/ollama",
  mistralai: "@langchain/mistralai",
  groq: "@langchain/groq",
  cerebras: "@langchain/cerebras",
  bedrock: "@langchain/aws",
  deepseek: "@langchain/deepseek",
  xai: "@langchain/xai",
  fireworks: "@langchain/community",
  together: "@langchain/community",
  perplexity: "@langchain/community",
};

function isLangchainPackageParseBug(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    typeof msg === "string" &&
    msg.includes("undefined is not an object") &&
    msg.includes("split")
  );
}

function providerFromModelArg(modelArg: string): string | undefined {
  if (modelArg?.includes(":")) {
    return modelArg.split(":", 1)[0];
  }
  return undefined;
}

/**
 * Initialize a chat model by provider and model name. Wraps langchain's
 * initChatModel and replaces the cryptic "undefined is not an object... split"
 * error with a clear message when the provider package is missing.
 */
export async function initChatModel(
  model: string,
  options?: Parameters<typeof langchainInitChatModel>[1]
): ReturnType<typeof langchainInitChatModel> {
  try {
    return await langchainInitChatModel(model, options);
  } catch (err) {
    const provider = providerFromModelArg(model);
    const isModuleNotFound =
      (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";
    if (isLangchainPackageParseBug(err) || isModuleNotFound) {
      const pkg = provider && PROVIDER_PACKAGES[provider];
      const hint = pkg
        ? `Install it with: npm install ${pkg} (or pnpm add ${pkg})`
        : provider
          ? `Install the required @langchain package for provider "${provider}"`
          : "Install the required @langchain integration package for your model provider.";
      throw new Error(
        `Missing model provider package. ${hint}. Original error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    throw err;
  }
}
