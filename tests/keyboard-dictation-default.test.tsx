import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	dispatchRegistryAction,
	kbdEventForAction,
	type RegistryDispatchHandlers,
} from "../components/keyboard-shortcuts.tsx";

/**
 * Dictation claims Alt+M's default action (owner follow-up): Option+M on
 * macOS reports `key: "µ"` and would otherwise type that character, and a
 * browser could act on the chord. The dispatcher now calls preventDefault
 * for toggle-dictation ONLY — every other action keeps its default.
 */

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document, CustomEvent: window.CustomEvent });

function keydown(init: {
	key: string;
	code: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}) {
	return Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), {
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...init,
	}) as unknown as KeyboardEvent;
}

const handlers: RegistryDispatchHandlers = {
	router: { push: () => {} },
	openSettings: () => {},
	setCheatOpen: () => {},
};

function dispatchAndCollect(init: Parameters<typeof keydown>[0]) {
	const seen: string[] = [];
	const event = keydown(init);
	const listener = (e: Event) => seen.push(e.type);
	const name = kbdEventForAction("toggle-dictation");
	window.addEventListener(name, listener);
	try {
		dispatchRegistryAction(event, handlers);
	} finally {
		window.removeEventListener(name, listener);
	}
	return { event, seen };
}

describe("toggle-dictation claims Alt+M's default action", () => {
	it("Alt+M (Latin layout) is prevented and dispatches the toggle", () => {
		const { event, seen } = dispatchAndCollect({ key: "m", code: "KeyM", altKey: true });
		assert.equal(event.defaultPrevented, true, "the browser default must not run");
		assert.deepEqual(seen, [kbdEventForAction("toggle-dictation")], "the mounted dictation hook hears it");
	});

	it("macOS Option+M reports key \"µ\" at KeyM — same prevention and dispatch", () => {
		const { event, seen } = dispatchAndCollect({ key: "µ", code: "KeyM", altKey: true });
		assert.equal(event.defaultPrevented, true, "Option+M must not type µ into the field");
		assert.deepEqual(seen, [kbdEventForAction("toggle-dictation")]);
	});

	it("the claim is scoped: another registry action keeps its default", () => {
		const event = keydown({ key: "k", code: "KeyK", ctrlKey: true });
		dispatchRegistryAction(event, handlers);
		assert.equal(event.defaultPrevented, false);
	});
});
