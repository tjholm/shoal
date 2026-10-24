/**
 * Sets the macOS tray icon's image without hiding the icon, through the
 * Objective-C runtime.
 *
 * Electrobun's Tray.setImage drops the template flag, so the icon stops
 * following the menu bar's light or dark look; Shoal worked around that by
 * hiding and re-showing the tray, which blinks the icon out on every change and
 * makes an animation all but invisible. Remove this once Electrobun's
 * setTrayImage keeps the flag.
 */
import { dlopen, FFIType, type Pointer } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";

// objc_msgSend takes whatever arguments the method does, so each shape it's
// called with needs its own binding.
const runtime = dlopen(LIBOBJC, {
	// Taking ptr rather than cstring lets callers pass a Buffer, which Bun keeps alive for the call.
	objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
	sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
	object_getClassName: { args: [FFIType.ptr], returns: FFIType.cstring },
}).symbols;
const send = dlopen(LIBOBJC, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols
	.objc_msgSend;
const sendPtr = dlopen(LIBOBJC, {
	objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols.objc_msgSend;
const sendPtrForBool = dlopen(LIBOBJC, {
	objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
}).symbols.objc_msgSend;
const sendU64 = dlopen(LIBOBJC, {
	objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
}).symbols.objc_msgSend;
const sendBool = dlopen(LIBOBJC, {
	objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.void },
}).symbols.objc_msgSend;
// NSSize is two doubles, which arm64 and x86_64 both pass in float registers.
const sendSize = dlopen(LIBOBJC, {
	objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64], returns: FFIType.void },
}).symbols.objc_msgSend;
const sendOnMain = dlopen(LIBOBJC, {
	objc_msgSend: {
		args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool],
		returns: FFIType.void,
	},
}).symbols.objc_msgSend;

const cString = (text: string) => Buffer.from(`${text}\0`);
const selectors = new Map<string, Pointer>();
const selector = (name: string) => {
	let found = selectors.get(name);
	if (!found) {
		found = runtime.sel_registerName(cString(name)) as Pointer;
		selectors.set(name, found);
	}
	return found;
};
const objcClass = (name: string) => runtime.objc_getClass(cString(name)) as Pointer;
const nsString = (text: string) =>
	sendPtr(objcClass("NSString"), selector("stringWithUTF8String:"), cString(text)) as Pointer;

/** The button of this app's one status item, found among the app's windows. */
const findTrayButton = (): Pointer | null => {
	const app = send(objcClass("NSApplication"), selector("sharedApplication")) as Pointer;
	const windows = send(app, selector("windows")) as Pointer;
	const count = Number(send(windows, selector("count")));
	for (let i = 0; i < count; i++) {
		const window = sendU64(windows, selector("objectAtIndex:"), i) as Pointer;
		if (runtime.object_getClassName(window).toString() !== "NSStatusBarWindow") continue;
		// statusItem is private. Asking first, instead of using valueForKey:, means a
		// macOS without it falls back: an Objective-C exception would crash the app.
		if (!sendPtrForBool(window, selector("respondsToSelector:"), selector("statusItem"))) continue;
		const item = send(window, selector("statusItem")) as Pointer | null;
		if (!item) continue;
		const button = send(item, selector("button")) as Pointer | null;
		// Retained so the pointer stays valid even if Electrobun replaces the status item.
		if (button) return send(button, selector("retain")) as Pointer;
	}
	return null;
};

const images = new Map<string, Pointer>();

/** Loads each image once, flagged as a template so macOS tints it for the menu bar. */
const templateImage = (file: string, size: number) => {
	const cached = images.get(file);
	if (cached) return cached;
	const image = sendPtr(send(objcClass("NSImage"), selector("alloc")), selector("initWithContentsOfFile:"), nsString(file)) as
		| Pointer
		| null;
	if (!image) throw new Error(`macOS couldn't load the tray image ${file}`);
	sendBool(image, selector("setTemplate:"), true);
	sendSize(image, selector("setSize:"), size, size);
	images.set(file, image);
	return image;
};

let button: Pointer | null = null;
let warned = false;

/** Shows `file` in the tray at once, as a template image; false when the tray button can't be found. */
export const setStatusItemImage = (file: string, size: number) => {
	// A button no longer in a window belongs to a status item that's been replaced.
	if (button && !send(button, selector("window"))) {
		send(button, selector("release"));
		button = null;
	}
	button ??= findTrayButton();
	if (!button) {
		if (!warned) console.warn("Couldn't find the tray's status item button; tray image changes will blink.");
		warned = true;
		return false;
	}
	// AppKit views belong to the main thread, and the app's JavaScript runs on another.
	sendOnMain(button, selector("performSelectorOnMainThread:withObject:waitUntilDone:"), selector("setImage:"), templateImage(file, size), false);
	return true;
};
