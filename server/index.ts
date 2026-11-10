import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
const runtime = await createApp();
const server = serve(
  { fetch: runtime.app.fetch, port: runtime.config.port, hostname: "0.0.0.0" },
  () => console.log(`Renewly listening on port ${runtime.config.port}`),
);
let pending: Promise<unknown> | null = null;
const tick = () => {
  if (!pending)
    pending = runtime
      .runReminders()
      .catch(() => console.error("Reminder scheduler failed."))
      .finally(() => {
        pending = null;
      });
};
const interval = setInterval(tick, runtime.config.reminderIntervalMs);
interval.unref();
const initial = setTimeout(tick, 5000);
initial.unref();
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  clearTimeout(initial);
  server.close(() => {
    void Promise.resolve(pending).finally(() => {
      runtime.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
