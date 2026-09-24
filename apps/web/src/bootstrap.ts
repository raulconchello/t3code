import { connectEmbedHost, EMBED_HOST_BUILD } from "./embedHost";
import { showBootError } from "./lib/bootError";

const loadApp = () => import("./main").then(({ startup }) => startup);

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
// Embedded builds first wait for the host to say which environment and
// workspace to use, since the app's connection catalog is built from it.
void (EMBED_HOST_BUILD ? connectEmbedHost().then(loadApp) : loadApp()).catch(showBootError);
