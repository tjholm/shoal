import { useSyncExternalStore } from "react";
import { TextMorph as TorphTextMorph, type TextMorphProps } from "torph/react";

const subscribeToVisibility = (onChange: () => void) => {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
};
const isVisible = () => !document.hidden;

/**
 * torph's TextMorph, animating only while the page is visible. Browsers
 * throttle animations in background tabs, so morphs from live counts piled
 * up there and all ran at once on return, freezing the page. Hidden, the
 * text just updates.
 */
export function TextMorph(props: TextMorphProps) {
	const visible = useSyncExternalStore(subscribeToVisibility, isVisible);
	return <TorphTextMorph {...props} disabled={props.disabled || !visible} />;
}
