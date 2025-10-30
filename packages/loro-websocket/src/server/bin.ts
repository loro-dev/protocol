import { SimpleServer } from "./simple-server";

const DEFAULT_PORT = 8787;
const rawPort = process.argv[2];
const port =
  rawPort !== undefined ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;

if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
  const invalidValue = rawPort ?? "";
  // eslint-disable-next-line no-console
  console.error(
    `Invalid port: "${invalidValue}". Provide a number between 1 and 65535.`
  );
  process.exit(1);
}

const server = new SimpleServer({ port });
server.start().then(() => {
  // eslint-disable-next-line no-console
  console.log(`SimpleServer listening on ws://localhost:${port}`);
});
