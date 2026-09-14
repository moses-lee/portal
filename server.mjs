import { createServer } from "node:http";
import next from "next";
import { shell } from "./src/lib/shell.ts";
import { attachShellServer } from "./src/lib/shell-server.ts";

const dev = !process.argv.includes("--production");
const port = Number(process.env.PORT || 3000);
const hostname = "0.0.0.0";
const server = createServer((req, res) => handle(req, res));
const app = next({ dev, hostname, port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();
const io = attachShellServer(server, shell);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  shell.dispose();
  io.close();
  // Active chat streams must not prevent the host (and its PTY) from stopping.
  setTimeout(() => process.exit(0), 1500).unref();
  await app.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => shell.dispose());
server.once("error", (error) => { console.error(error); shell.dispose(); process.exit(1); });
server.listen(port, hostname, () => console.log(`Portal ready at http://localhost:${port}`));
