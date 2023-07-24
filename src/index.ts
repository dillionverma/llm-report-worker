import { PrismaClient } from "@prisma/client/edge";

const prisma = new PrismaClient();

const CACHE_AGE = 60 * 60 * 24 * 30; // 30 days

addEventListener("fetch", (event) => {
  event.respondWith(handleEvent(event));
});

async function sha256(message: string) {
  // encode as UTF-8
  const msgBuffer = new TextEncoder().encode(message);
  // hash the message
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  // convert bytes to hex string
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const getUrl = async (request: Request) => {
  const originalUrl = new URL(request.url);
  const openaiUrl =
    "https://api.openai.com" + originalUrl.pathname + originalUrl.search;

  return openaiUrl;
};

const getCompletionFromStream = (stream: string): string => {
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

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  [key: string]: any;
}

const saveRequestToDb = async (
  request: Request,
  response: Response,
  url: string,
  body: { [key: string]: any },
  metadata: { [key: string]: any },
  cached: boolean = false,
  streamed: boolean = false,
  userId: string,
  data?: { [key: string]: any },
  streamed_data?: string
) => {
  let streamed_id: string = "";
  let completion: string = "";

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
  } else if (url === "https://api.openai.com/v1/completions") {
    completion = data?.choices[0].text;
  }

  try {
    const r = prisma.request.create({
      data: {
        openai_id: streamed ? streamed_id : data?.id,
        ip: request.headers.get("x-real-ip") || "",
        url: url,
        method: request.method,
        status: response.status,
        request_headers: Object.fromEntries(request.headers.entries()),
        request_body: body,
        response_headers: Object.fromEntries(response.headers.entries()),

        response_body: streamed ? undefined : data,
        streamed_response_body: streamed ? streamed_data : undefined,

        cached: cached,
        streamed: streamed,

        user_id: request.headers.get("X-User-Id"),

        completion: completion,

        metadata: {
          create: [
            ...Object.entries(metadata || {}).map(([key, value]) => ({
              key: key,
              value: value,
            })),
          ],
        },
        userId: userId,
      },
    });

    return r;
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

const getUser = async (apiKey: string) => {
  const key = await prisma.apiKey.findUnique({
    where: {
      hashed_key: await sha256(apiKey),
    },
    include: {
      user: true,
    },
  });

  return key?.user;
};

async function handleEvent(event: FetchEvent): Promise<Response> {
  const { request } = event;
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

  const user = await getUser(key);

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

  let metadata: { [key: string]: string } = {};
  let restBody: { [key: string]: any } = {};

  if (method === "POST") {
    let { metadata: meta, ...rest } = JSON.parse(body);
    restBody = rest;
    metadata = meta;

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
      event.waitUntil(cache.put(cacheKey, response.clone()));
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

      reader.read().then(async function process({ done, value }): Promise<any> {
        if (done) {
          // console.log("Stream complete. Result:");
          // console.log(responseData);
          // Store responseData in your database
          event.waitUntil(
            saveRequestToDb(
              request,
              c,
              url,
              JSON.parse(body),
              metadata,
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
        console.log(text);

        responseData += text;
        return reader.read().then(process);
      });

      return response;
    } else {
      console.log("Stream is false");

      const c = response.clone();

      event.waitUntil(
        saveRequestToDb(
          request,
          c,
          url,
          JSON.parse(body),
          metadata,
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
}
