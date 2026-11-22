/**
 * Two devices edit the same task while offline, then reconnect.
 * Run: npm run demo
 */
import { FaultyTransport, LocalTransport, MemoryStorage, SyncClient, SyncServer, seededRandom } from "../src/index.js";

const server = new SyncServer();
const net = (seed: number) => new FaultyTransport(new LocalTransport(server), {}, seededRandom(seed));
const phoneNet = net(1);
const laptopNet = net(2);
const phone = await SyncClient.open({ clientId: "phone", transport: phoneNet, storage: new MemoryStorage() });
const laptop = await SyncClient.open({ clientId: "laptop", transport: laptopNet, storage: new MemoryStorage() });

await phone.set("tasks", "t1", { title: "Prepare board pack", done: false, owner: "Rubbaite" });
await phone.sync();
await laptop.sync();
console.log("both online      :", laptop.get("tasks", "t1"));

phoneNet.faults = { offline: true };
laptopNet.faults = { offline: true };
await phone.set("tasks", "t1", { done: true });
await laptop.set("tasks", "t1", { title: "Prepare board pack (v2)" });
console.log("phone, offline   :", phone.get("tasks", "t1"), `(${phone.pending} pending)`);
console.log("laptop, offline  :", laptop.get("tasks", "t1"), `(${laptop.pending} pending)`);

phoneNet.faults = { dropResponse: 0.5, duplicate: 0.5 }; // a flaky network on the way back
laptopNet.faults = {};
await phone.sync().catch(() => phone.sync());
await laptop.sync();
await phone.sync();
console.log("after sync, phone :", phone.get("tasks", "t1"));
console.log("after sync, laptop:", laptop.get("tasks", "t1"));
console.log("server log entries:", server.logLength, "(no duplicates despite retries)");
