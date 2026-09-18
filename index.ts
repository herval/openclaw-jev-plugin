import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerJevGate } from "./src/plugin.js";

export default definePluginEntry({
  id: "jev-gate",
  name: "Jev Reply Gate",
  description: "Asks TypeSafe Jev whether the assistant should answer an incoming message.",
  register(api) {
    registerJevGate(api);
  },
});
