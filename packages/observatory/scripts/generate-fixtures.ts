import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actorStreamFixtures, fixtureDir } from "../src/actor-stream-fixtures.test-support.js";

mkdirSync(fixtureDir, { recursive: true });
for (const [name, bytes] of actorStreamFixtures()) {
	writeFileSync(join(fixtureDir, name), bytes);
}
