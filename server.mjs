import { createServer } from "node:http";
import next from "next";
import { terminals } from "./src/lib/terminals.ts";
import { attachTerminalServer } from "./src/lib/shell-server.ts";

const dev = !process.argv.includes("--production");
const port = Number(process.env.PORT || 3000);
const hostname = "0.0.0.0";
const server = createServer((req, res) => handle(req, res));
const app = next({ dev, hostname, port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();
const io = attachTerminalServer(server, terminals);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  terminals.disposeAll();
  io.close();
  // Stop the orchestrator's scheduler and any turn it is running before its sessions go away; like
  // the ACP runtime below, it lives on a global shared with Next's bundle (see src/lib/orchestrator/runtime.ts).
  await globalThis.__portalOrchestrator?.dispose().catch(() => {});
  // Stop the agent processes and flush pending session writes; the runtime lives on the global
  // shared with Next's bundle (see src/lib/acp.ts) because this file cannot import it directly.
  await globalThis.__portalMultiAgentAcp?.dispose().catch(() => {});
  // Active chat streams must not prevent the host (and its PTYs) from stopping.
  setTimeout(() => process.exit(0), 1500).unref();
  await app.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => terminals.disposeAll());
server.once("error", (error) => { console.error(error); terminals.disposeAll(); process.exit(1); });
server.listen(port, hostname, () => console.log(`Portal ready at http://localhost:${port}`));
