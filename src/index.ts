import { Client } from "pg";
import {
  getCompletionFromStream,
  getTokenCount,
  getUrl,
  numTokensFromMessages,
  sha256,
} from "./lib";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  DATABASE_URL: string;
}

const CACHE_AGE = 60 * 60 * 24 * 30; // 30 days

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  [key: string]: any;
}

const saveRequestToDb = async (
  client: Client,
  request: Request,
  response: Response,
  url: string,
  body: { [key: string]: any },
  cached: boolean = false,
  streamed: boolean = false,
  userId: string,
  data?: { [key: string]: any },
  streamed_data?: string
) => {
  let streamed_id: string = "";
  let completion: string = "";
  let model: string = "";
  let prompt_tokens: number = 0;
  let completion_tokens: number = 0;

  // Convert Request and Response headers to JSON
  const requestHeaders = request.headers;
  const responseHeaders = response.headers;

  const currentTimestamp = new Date().toISOString();

  if (streamed) {
    const data = streamed_data?.split("\n\n")[0].replace("data: ", "");
    const parsed = JSON.parse(data!);
    streamed_id = parsed.id;
    console.log("Streamed id:", streamed_id);
  }

  if (url === "https://api.openai.com/v1/chat/completions") {
    if (streamed) {
      completion = getCompletionFromStream(streamed_data!);
    } else {
      completion = data?.choices[0].message.content;
    }
    prompt_tokens = numTokensFromMessages(body.messages);
    completion_tokens = getTokenCount(completion);
    model = body.model;
  } else if (url === "https://api.openai.com/v1/completions") {
    completion = data?.choices[0].text;
    prompt_tokens = getTokenCount(body?.prompt);
    completion_tokens = getTokenCount(completion);
    model = body.model;
  }

  try {
    // Insert into Request table
    const requestInsertQuery = `
     INSERT INTO "Request" (
       id, openai_id, ip, url, method, status,
       request_headers, request_body, response_headers, response_body,
       streamed_response_body, cached, streamed, user_id,
       prompt_tokens, completion_tokens, model, completion, "userId",     "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
     ) RETURNING id`;

    const openaiId = streamed ? streamed_id : data?.id || "";
    const requestInsertValues = [
      openaiId,
      requestHeaders.get("x-real-ip") || "",
      url,
      request.method,
      response.status,
      JSON.stringify(requestHeaders),
      JSON.stringify(body),
      JSON.stringify(responseHeaders),
      streamed ? undefined : JSON.stringify(data),
      streamed ? streamed_data : undefined,
      cached,
      streamed,
      requestHeaders.get("X-User-Id"),
      prompt_tokens,
      completion_tokens,
      model,
      completion,
      userId,
      currentTimestamp, // Set createdAt to currentTimestamp
      currentTimestamp, // Set updatedAt to currentTimestamp
    ];

    const requestResult = await client.query(
      requestInsertQuery,
      requestInsertValues
    );

    return requestResult.rows[0];
  } catch (e) {
    console.error(e);
    return null;
  }
};

const logHeaders = async (headers: Headers) => {
  console.log(
    JSON.stringify(Object.fromEntries(headers.entries()), null, 2),
    "\n"
  );
};

const getApiKey = async (request: Request) => {
  const headers = request.headers;
  const authHeader = headers.get("X-Api-Key");
  if (!authHeader) return null;

  const apiKey = authHeader.replace("Bearer ", "");
  return apiKey;
};

const getUser = async (client: Client, apiKey: string) => {
  const hashedApiKey = await sha256(apiKey);

  const query = {
    text: 'SELECT "User".* FROM "ApiKey" JOIN "User" ON "ApiKey"."userId" = "User".id WHERE "ApiKey".hashed_key = $1',
    values: [hashedApiKey],
  };

  console.log("sending query");

  const result = await client.query(query);

  console.log("sent query");

  // Check if the user was found
  if (result.rows.length > 0) {
    return result.rows[0]; // Return the found user
  } else {
    return null; // Return null if no user was found
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const headers = request.headers;
    const body = await request.clone().text();
    const method = request.method;

    const url = await getUrl(request);

    const key = await getApiKey(request);

    if (!key) {
      return new Response(
        JSON.stringify({
          message: "Go to https://llm.report/ to get an API key.",
          error: "Missing API key in X-Api-Key header.",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "Application/json",
          },
        }
      );
    }

    const client = new Client(env.DATABASE_URL);

    await client.connect();

    const user = await getUser(client, key);

    if (!user) {
      return new Response(
        JSON.stringify({
          message: "Go to https://llm.report/ to get an API key.",
          error: "User not found.",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "Application/json",
          },
        }
      );
    }

    // let metadata: { [key: string]: string } = {};
    let restBody: { [key: string]: any } = {};

    if (method === "POST") {
      let { ...rest } = JSON.parse(body);
      restBody = rest;
      // metadata = meta;

      const cacheUrl = new URL(request.url);
      const hash = await sha256(body);
      cacheUrl.pathname = "/posts" + cacheUrl.pathname + "/" + hash;
      console.log("Cache url path: ", cacheUrl.pathname);

      const cacheKey = new Request(cacheUrl.toString(), {
        headers: request.headers,
        method: "GET",
      });

      const cache = caches.default;
      let response = await cache.match(cacheKey);

      logHeaders(headers);

      console.log("Cache key: ", cacheUrl.toString());

      let cached = false;

      if (!response) {
        cached = false;
        console.log("miss");
        const initialResponse = await fetch(url, request);

        logHeaders(initialResponse.headers);

        const headers = new Headers(initialResponse.headers);
        headers.set("cache-control", `public, max-age=${CACHE_AGE}`);

        logHeaders(headers);

        // Create a new response with the transformed readable stream
        response = new Response(initialResponse.body, {
          status: initialResponse.status,
          statusText: initialResponse.statusText,
          headers,
        });

        // if (headers.get("llm-cache-enabled") === "true") {
        // console.log("Caching enabled");

        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        // } catch (e) {
        //   console.error("Error: ", e);
        // }
        // }
      } else {
        cached = true;
        console.log("hit");
      }

      const isStream = JSON.parse(body).stream === true;

      if (isStream) {
        const c = response.clone();
        const reader = c.body.getReader();
        const decoder = new TextDecoder();

        let responseData = "";

        reader
          .read()
          .then(async function process({ done, value }): Promise<any> {
            if (done) {
              // console.log("Stream complete. Result:");
              // console.log(responseData);
              // Store responseData in your database
              ctx.waitUntil(
                saveRequestToDb(
                  client,
                  request,
                  c,
                  url,
                  JSON.parse(body),
                  // metadata,
                  cached,
                  true,
                  user.id,
                  undefined,
                  responseData
                )
              );
              return;
            }

            const text = decoder.decode(value, { stream: true });
            // console.log(text);

            responseData += text;
            return reader.read().then(process);
          });

        return response;
      } else {
        console.log("Stream is false");

        const c = response.clone();

        ctx.waitUntil(
          saveRequestToDb(
            client,
            request,
            c,
            url,
            JSON.parse(body),
            // metadata,
            cached,
            false,
            user.id,
            await c.json()
          )
        );
        return response;
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
