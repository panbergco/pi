import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import type { Component, TuiMouseEvent } from "../src/tui.ts";

function wheel(y: number, width = 20, height = 5): TuiMouseEvent {
	return {
		type: "wheel",
		button: "none",
		x: 0,
		y,
		screenX: 0,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: -1,
	};
}

function content(seen: TuiMouseEvent[], handled: boolean): Component {
	return {
		render: () => Array.from({ length: 100 }, (_, index) => `line ${index}`),
		invalidate: () => {},
		handleMouse: (event) => {
			seen.push(event);
			return handled ? { handled: true } : undefined;
		},
	};
}

describe("ScrollView mouse forwarding", () => {
	it("reports the scrolled content row, not the viewport row", () => {
		const seen: TuiMouseEvent[] = [];
		const view = new ScrollView(content(seen, true), { follow: "none" });
		view.updateLayout(100, 5, () => {});
		view.scrollTo(40);

		assert.strictEqual(view.handleMouse(wheel(2))?.handled, true);
		assert.strictEqual(seen.length, 1);
		assert.strictEqual(seen[0].y, 42);
		assert.strictEqual(seen[0].height, 100);
	});

	it("leaves the event unhandled when the content does not take it", () => {
		const seen: TuiMouseEvent[] = [];
		const view = new ScrollView(content(seen, false), { follow: "none" });
		view.updateLayout(100, 5, () => {});

		assert.strictEqual(view.handleMouse(wheel(1)), undefined);
		assert.strictEqual(seen.length, 1);
	});

	it("ignores rows outside the viewport", () => {
		const seen: TuiMouseEvent[] = [];
		const view = new ScrollView(content(seen, true), { follow: "none" });
		view.updateLayout(100, 5, () => {});

		assert.strictEqual(view.handleMouse(wheel(5)), undefined);
		assert.strictEqual(view.handleMouse(wheel(-1)), undefined);
		// The wheel still reaches the viewport itself, which is what scrolls it.
		assert.strictEqual(seen.length, 0);
	});
});
