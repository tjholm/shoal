import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkerApp } from "../src";
import { httpHost, isSignedIn, signIn } from "./http";
import { SignIn } from "./SignIn";
import "./styles.css";

const lightScheme = window.matchMedia("(prefers-color-scheme: light)");
lightScheme.addEventListener("change", (event) => {
	document.documentElement.classList.toggle("light", event.matches);
});

function Root() {
	const [session, setSession] = useState<"checking" | "signed-out" | "signed-in">("checking");
	const host = useMemo(() => httpHost(() => setSession("signed-out")), []);

	useEffect(() => {
		// The worker prints a link with the token after #, which browsers never send to servers.
		const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
		if (token !== null) window.history.replaceState(null, "", window.location.pathname);
		void (token !== null ? signIn(token) : isSignedIn()).then((ok) => setSession(ok ? "signed-in" : "signed-out"));
	}, []);

	if (session === "checking") return null;
	if (session === "signed-out") return <SignIn onSignedIn={() => setSession("signed-in")} />;
	return <WorkerApp host={host} />;
}

createRoot(document.getElementById("app") as HTMLElement).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
