import GPT3Tokenizer from "gpt3-tokenizer";

export async function sha256(message: string) {
  // encode as UTF-8
  const msgBuffer = new TextEncoder().encode(message);
  // hash the message
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  // convert bytes to hex string
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const getUrl = async (request: Request) => {
  const originalUrl = new URL(request.url);
  const openaiUrl =
    "https://api.openai.com" + originalUrl.pathname + originalUrl.search;

  return openaiUrl;
};

export const getCompletionFromStream = (stream: string): string => {
  if (!stream) return "";
  const events = stream
    .split("\n")
    .filter((e) => e.length > 0)
    .slice(0, -1); // cut off the last one

  let completion = "";

  for (const event of events) {
    const json = event.replace("data: ", "");
    const parsed = JSON.parse(json);

    completion += parsed.choices[0].delta.content || "";
  }

  return completion;
};

export type Message = {
  role: string;
  content: string;
  name?: string;
  function_call?: string;
};

// https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
export function numTokensFromMessages(
  messages: Message[],
  model: string = "gpt-3.5-turbo-0613"
): number {
  const tokenizer = new GPT3Tokenizer({ type: "codex" });
  let tokensPerMessage: number;
  let tokensPerName: number;
  if (
    [
      "gpt-3.5-turbo-0613",
      "gpt-3.5-turbo-16k-0613",
      "gpt-4-0314",
      "gpt-4-32k-0314",
      "gpt-4-0613",
      "gpt-4-32k-0613",
    ].includes(model)
  ) {
    tokensPerMessage = 3;
    tokensPerName = 1;
  } else if (model === "gpt-3.5-turbo-0301") {
    tokensPerMessage = 4; // every message follows {role/name}\n{content}\n
    tokensPerName = -1; // if there's a name, the role is omitted
  } else if (model.includes("gpt-3.5-turbo")) {
    console.log(
      "Warning: gpt-3.5-turbo may update over time. Returning num tokens assuming gpt-3.5-turbo-0613."
    );
    return numTokensFromMessages(messages, "gpt-3.5-turbo-0613");
  } else if (model.includes("gpt-4")) {
    console.log(
      "Warning: gpt-4 may update over time. Returning num tokens assuming gpt-4-0613."
    );
    return numTokensFromMessages(messages, "gpt-4-0613");
  } else {
    throw new Error(
      `numTokensFromMessages() is not implemented for model ${model}. See https://github.com/openai/openai-python/blob/main/chatml.md for information on how messages are converted to tokens.`
    );
  }

  let numTokens = 0;
  for (const message of messages) {
    numTokens += tokensPerMessage;
    for (const [key, value] of Object.entries(message)) {
      const encoded = tokenizer.encode(value);
      numTokens += encoded.bpe.length;
      if (key === "name") {
        numTokens += tokensPerName;
      }
    }
  }
  numTokens += 3; // every reply is primed with assistant
  return numTokens;
}

const tokenizer = new GPT3Tokenizer({ type: "gpt3" }); // or 'codex'

// https://github.com/botisan-ai/gpt3-tokenizer#readme
export const getTokenCount = (str: string) => {
  const encoded: { bpe: number[]; text: string[] } = tokenizer.encode(str);
  return encoded.bpe.length;
};
