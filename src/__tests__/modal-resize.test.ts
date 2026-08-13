import { describe, expect, test } from "bun:test";
import { resizeOrClose, type Modal } from "../modal";

// SIGWINCH closes the active modal because a modal sizes itself at open. That
// is right for a modal that is one screen and wrong for one that is a flow:
// closing discards every step behind you and any half-typed value, on a window
// drag. The rule lives here rather than in main.ts's handler because main.ts
// cannot be imported by a test.

function stub(withResize: boolean) {
  const state = { closed: false, sized: [] as Array<[number, number]> };
  const modal: Modal = {
    isOpen: () => !state.closed,
    preferredWidth: () => 40,
    getGrid: () => ({ cells: [], width: 0, height: 0 }) as unknown as ReturnType<Modal["getGrid"]>,
    getCursorPosition: () => null,
    handleInput: () => ({ type: "consumed" }),
    close: () => { state.closed = true; },
    ...(withResize
      ? { onResize: (c: number, r: number) => { state.sized.push([c, r]); } }
      : {}),
  };
  return { modal, state };
}

describe("resizeOrClose", () => {
  test("a modal that cannot re-lay out is closed, exactly as before", () => {
    const { modal, state } = stub(false);
    expect(resizeOrClose(modal, 100, 30)).toBe("closed");
    expect(state.closed).toBe(true);
  });

  test("a modal that can re-lay out survives, and is told the new size", () => {
    const { modal, state } = stub(true);
    expect(resizeOrClose(modal, 100, 30)).toBe("resized");
    expect(state.closed).toBe(false);
    expect(state.sized).toEqual([[100, 30]]);
  });

  test("no modal is a no-op rather than an error", () => {
    expect(resizeOrClose(null, 100, 30)).toBe("none");
  });

  test("repeated resizes keep the modal open", () => {
    const { modal, state } = stub(true);
    resizeOrClose(modal, 80, 24);
    resizeOrClose(modal, 120, 40);
    expect(state.closed).toBe(false);
    expect(state.sized).toEqual([[80, 24], [120, 40]]);
  });
});
