/**
 * Validate a post-auth redirect target. Only same-origin path-style URLs are
 * allowed — rejects protocol-relative ("//evil"), absolute ("https://evil"),
 * and anything that isn't a clean app path.
 */
export function safeRedirect(target: string | undefined): string {
	if (!target) return "/";
	if (!target.startsWith("/")) return "/";
	if (target.startsWith("//")) return "/";
	return target;
}
