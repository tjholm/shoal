import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const lightScheme = window.matchMedia("(prefers-color-scheme: light)");
lightScheme.addEventListener("change", (event) => {
	document.documentElement.classList.toggle("light", event.matches);
});

createRoot(document.getElementById("app") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
