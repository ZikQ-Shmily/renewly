import { resolve, join, dirname } from "node:path";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { openDatabase, migrate } from "./db.js";
const [command, target] = process.argv.slice(2),
  path = join(resolve(process.env.DATA_DIR || "./data"), "renewly.sqlite");
if (command === "backup") {
  if (!target || !existsSync(path)) {
    console.error(
      "Usage: node dist/server/cli.js backup <output.sqlite>; source database must exist.",
    );
    process.exit(1);
  }
  const destination = resolve(target);
  if (destination === path) {
    console.error("Backup target must differ from source.");
    process.exit(1);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const db = openDatabase(path);
  try {
    await db.backup(destination);
    chmodSync(destination, 0o600);
    console.log(`Backup created: ${destination}`);
  } finally {
    db.close();
  }
} else if (command === "migrate") {
  const db = openDatabase(path);
  try {
    migrate(db);
    console.log("Database migrations applied.");
  } finally {
    db.close();
  }
} else {
  console.error(
    "Usage: node dist/server/cli.js migrate | backup <output.sqlite>",
  );
  process.exitCode = 1;
}
