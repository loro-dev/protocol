import { SimpleServer } from "../src/server/simple-server";
import { pathToFileURL } from "node:url";

async function main() {
  const host = process.argv[2] || "127.0.0.1";
  const port = Number(process.argv[3] || 0);
  const server = new SimpleServer({ port, host });
  await server.start();
  console.log(`[wrapper] SimpleServer listening on ws://${host}:${port}`);
  // Keep the process alive so the server continues listening until killed.
  // Handle SIGINT/SIGTERM for graceful shutdown if invoked directly.
  const never = new Promise<void>(() => {});
  process.on(
    "SIGINT",
    () =>
      void server
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
  );
  process.on(
    "SIGTERM",
    () =>
      void server
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
  );
  await never;
}

// ESM entrypoint guard
const scriptArg = process.argv[1];
const isEntrypoint =
  typeof scriptArg === "string" &&
  import.meta.url === pathToFileURL(scriptArg).href;
if (isEntrypoint) {
  // eslint-disable-next-line unicorn/prefer-top-level-await
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export default main;
