import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./styles/tokens.css";
import "./styles/bundle.css";
import "./styles/app.css";
import "./styles/elevation.css";
import { applyTheme, getTheme } from "./lib/theme";

applyTheme(getTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
