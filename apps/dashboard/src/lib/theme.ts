import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";

const STORAGE_KEY = "theme";

function isThemeMode(value: unknown): value is ThemeMode {
	return value === "light" || value === "dark" || value === "auto";
}

export function getStoredMode(): ThemeMode {
	if (typeof window === "undefined") return "auto";
	const stored = window.localStorage.getItem(STORAGE_KEY);
	return isThemeMode(stored) ? stored : "auto";
}

export function applyThemeMode(mode: ThemeMode): void {
	if (typeof window === "undefined") return;
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;

	const root = document.documentElement;
	root.classList.remove("light", "dark");
	root.classList.add(resolved);

	if (mode === "auto") {
		root.removeAttribute("data-theme");
	} else {
		root.setAttribute("data-theme", mode);
	}
	root.style.colorScheme = resolved;
}

/**
 * React hook that returns the current theme mode and a setter that
 * persists the choice and applies it to <html>. Re-applies on system
 * preference change when in `auto` mode.
 */
export function useTheme(): [ThemeMode, (next: ThemeMode) => void] {
	const [mode, setModeState] = useState<ThemeMode>("auto");

	useEffect(() => {
		setModeState(getStoredMode());
	}, []);

	useEffect(() => {
		if (mode !== "auto") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => applyThemeMode("auto");
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [mode]);

	function setMode(next: ThemeMode) {
		setModeState(next);
		applyThemeMode(next);
		window.localStorage.setItem(STORAGE_KEY, next);
	}

	return [mode, setMode];
}
