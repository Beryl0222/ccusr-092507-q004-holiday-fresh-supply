import { readFile } from "node:fs/promises";
import { validateEvent } from "./contracts.js";

const [, , schemaPath, eventPath] = process.argv;
if (!schemaPath || !eventPath) {
  console.error("用法: node src/cli.js <schema.json> <event.json>");
  process.exitCode = 2;
} else {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const issues = validateEvent(event, schema);
  if (issues.length === 0) {
    console.log("valid");
  } else {
    for (const issue of issues) console.log(`${issue.field}	${issue.code}	${issue.message}`);
    process.exitCode = 1;
  }
}
