import { showBootError } from "./lib/bootError";

const loadApp = () => import("./main").then(({ startup }) => startup);

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
// Embedded builds first wait for the host to say which environment and
// workspace to use, since the app's connection catalog is built from it. The
// check stays inline so stock builds drop the embed branch and this entry keeps
// no static imports beyond the boot error screen.
const start =
  import.meta.env.VITE_T3CODE_EMBED_HOST === "vscode"
    ? import("./embedHost").then(({ connectEmbedHost }) => connectEmbedHost()).then(loadApp)
    : loadApp();
void start.catch(showBootError);
