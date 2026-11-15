// Stand-in Chrome: the same inherited fds and NUL framing as --remote-debugging-pipe.
import { createReadStream, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const control = JSON.parse(readFileSync(join(dir, "control.json"), "utf8"));
writeFileSync(join(dir, "launch.json"), JSON.stringify({ args: process.argv.slice(2), env: process.env, pid: process.pid }));
const input = createReadStream(null, { fd: 3 });
const output = createWriteStream(null, { fd: 4 });
const send = message => output.write(JSON.stringify(message) + "\0");
let buffer = "";
input.setEncoding("utf8");
input.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const { id, method, sessionId } = message;
    if (control.hang) continue;
    const result = method === "Target.createTarget" ? { targetId: "page" } : method === "Target.attachToTarget" ? { sessionId: "session" } :
      method === "Runtime.evaluate" ? { result: { value: "A page" } } : method === "Page.captureScreenshot" ? { data: "iVBORw0KGgo=" } : {};
    send({ id, result, ...(sessionId && { sessionId }) });
    if (method === "Page.navigate") {
      for (const event of control.events ?? []) send({ ...event, sessionId });
      send({ method: "Page.loadEventFired", params: {}, sessionId });
    }
  }
});
