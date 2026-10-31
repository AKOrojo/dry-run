import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./styles/tokens.css";
import "./styles/bundle.css";
import "./styles/app.css";
import "./styles/elevation.css";
import { applyTheme, getTheme } from "./lib/theme";
import { reloadForNewBuild } from "./lib/lazy";

applyTheme(getTheme());
// A chunk preload failed (usually a deploy replaced the build under an open tab): reload once instead of breaking.
window.addEventListener("vite:preloadError", (e) => { if (reloadForNewBuild()) e.preventDefault(); });

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
