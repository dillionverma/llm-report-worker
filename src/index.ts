import { PrismaClient } from "@prisma/client/edge";
const prisma = new PrismaClient();

addEventListener("fetch", (event) => {
  event.respondWith(handleEvent(event));
});

async function sha256(message: string) {
  // encode as UTF-8
  const msgBuffer = await new TextEncoder().encode(message);
  // hash the message
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  // convert bytes to hex string
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function callOpenAI(request: Request): Promise<Response> {
  const originalUrl = new URL(request.url);
  const openaiUrl =
    "https://api.openai.com" + originalUrl.pathname + originalUrl.search;

  console.log("url", openaiUrl);
  const headers = request.headers;
  const body = await request.text();
  const method = request.method;

  let response: Response;

  if (method === "POST") {
    // Remove metadata before sending
    const { metadata, ...restBody } = JSON.parse(body);
    response = await fetch(openaiUrl, {
      method: method,
      headers: headers,
      body: JSON.stringify(restBody),
    });
    return response;
  } else if (method === "GET") {
    response = await fetch(openaiUrl, {
      method: method,
      headers: headers,
    });
  } else {
    return new Response("Method not allowed", { status: 405 });
  }
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  [key: string]: any;
}

async function handleEvent(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const res = await callOpenAI(request);
  const data: OpenAIResponse = await res.json();

  // waitUntil method is used for sending logs, after response is sent
  event.waitUntil(
    prisma.request
      .create({
        data: {
          id: data.id,
          url: request.url,
          method: request.method,
          status: res.status,
          request_headers: JSON.stringify(request.headers),
          request_body: JSON.stringify(request.body),
          response_headers: JSON.stringify(res.headers),
          response_body: JSON.stringify(data),
        },
      })
      .then()
  );

  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
}
