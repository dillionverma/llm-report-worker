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

async function handleEvent(event: FetchEvent): Promise<Response> {
  const { request } = event;

  // waitUntil method is used for sending logs, after response is sent
  event.waitUntil(
    prisma.request
      .create({
        data: {
          url: request.url,
          // method: request.method,
          // message: `${request.method} ${request.url}`,
          // meta: {
          //   headers: JSON.stringify(request.headers),
          // },
        },
      })
      .then()
  );

  return new Response(`request method: ${request.method}!`);
}
