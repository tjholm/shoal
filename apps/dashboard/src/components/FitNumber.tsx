import { useLayoutEffect, useRef, useState } from "react";
import { TextMorph } from "./TextMorph";

const UNITS = [
	{ size: 1e9, suffix: "B" },
	{ size: 1e6, suffix: "M" },
	{ size: 1e3, suffix: "K" },
] as const;

/** Every character `numberForms` can produce. */
const GLYPHS = "0123456789,.KMB";

/** Ways to write `n`, longest first: every digit, then two, one and no
 *  decimals of the largest unit the rounded value reaches, so 999,999 reads
 *  "1.00M", not "1000K". */
export function numberForms(n: number): string[] {
	const forms = [Math.round(n).toLocaleString("en-US")];
	if (n >= 1000) {
		for (const decimals of [2, 1, 0]) {
			const unit =
				UNITS.find((u) => Number((n / u.size).toFixed(decimals)) >= 1) ?? UNITS[UNITS.length - 1];
			forms.push(`${(n / unit.size).toFixed(decimals)}${unit.suffix}`);
		}
	}
	return [...new Set(forms)];
}

interface Box {
	readonly width: number;
	readonly glyphWidths: ReadonlyMap<string, number>;
}

/**
 * A count with as many digits as fit its box: every digit when there's room,
 * down to "12M" when there isn't, morphing between forms as the box resizes,
 * as in torph's responsive example. Glyphs are measured once per resize, so
 * a ticking value costs no layout reads.
 */
export function FitNumber({ value, className = "" }: { value: number; className?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [box, setBox] = useState<Box | null>(null);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () =>
			setBox({ width: element.clientWidth, glyphWidths: measureGlyphs(element) });
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		// Glyph widths change when a web font finishes loading.
		void document.fonts.ready.then(measure);
		return () => observer.disconnect();
	}, []);

	const forms = numberForms(value);
	const shown = box
		? (forms.find((form) => textWidth(form, box.glyphWidths) <= box.width) ?? forms.at(-1))
		: forms[0];

	return (
		<span ref={ref} className={`block min-w-0 ${className}`}>
			<TextMorph as="span">{shown}</TextMorph>
		</span>
	);
}

/** Each glyph's width in `element`'s font, via a hidden child that inherits it. */
function measureGlyphs(element: HTMLElement): Map<string, number> {
	const probe = document.createElement("span");
	probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
	element.appendChild(probe);
	const widths = new Map(
		[...GLYPHS].map((glyph) => {
			probe.textContent = glyph;
			return [glyph, probe.getBoundingClientRect().width] as const;
		}),
	);
	probe.remove();
	return widths;
}

function textWidth(text: string, glyphWidths: ReadonlyMap<string, number>): number {
	let width = 0;
	for (const char of text) width += glyphWidths.get(char) ?? 0;
	return width;
}
