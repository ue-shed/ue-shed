/** Child used only to prove that process death cannot commit a staged transaction. */
import { openSqlite } from "./driver.ts";
const db = await openSqlite(process.argv[2]!, "node", true);
db.exec("BEGIN IMMEDIATE; UPDATE line SET audience='player' WHERE rank=0");
process.stdout.write("staged\n");
setInterval(() => {}, 1000);
