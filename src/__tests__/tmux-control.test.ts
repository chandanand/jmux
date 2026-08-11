import { describe, test, expect } from "bun:test";
import { ControlParser, type ControlEvent } from "../tmux-control";

describe("ControlParser", () => {
  test("emits sessions-changed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%sessions-changed\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("sessions-changed");
  });

  test("emits session-changed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%session-changed $3\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("session-changed");
    if (events[0].type === "session-changed") {
      expect(events[0].args).toBe("$3");
    }
  });

  test("collects response block between %begin and %end", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%begin 1234 721599 1\n");
    parser.feed("line one\n");
    parser.feed("line two\n");
    parser.feed("%end 1234 721599 1\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("response");
    if (events[0].type === "response") {
      expect(events[0].commandNumber).toBe(721599);
      expect(events[0].flags).toBe(1);
      expect(events[0].lines).toEqual(["line one", "line two"]);
    }
  });

  test("emits error response on %error", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%begin 1234 2 1\n");
    parser.feed("something bad\n");
    parser.feed("%error 1234 2 1\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].commandNumber).toBe(2);
      expect(events[0].flags).toBe(1);
      expect(events[0].lines).toEqual(["something bad"]);
    }
  });

  test("parses flags field from %begin/%end", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    // flags=0 means response is NOT from this client (e.g. initial attach)
    parser.feed("%begin 1234 100 0\n");
    parser.feed("%end 1234 100 0\n");

    // flags=1 means response IS from this client
    parser.feed("%begin 1234 200 1\n");
    parser.feed("data\n");
    parser.feed("%end 1234 200 1\n");

    expect(events.length).toBe(2);
    if (events[0].type === "response") {
      expect(events[0].flags).toBe(0);
    }
    if (events[1].type === "response") {
      expect(events[1].flags).toBe(1);
    }
  });

  test("emits subscription-changed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%subscription-changed attention main=1 dev=\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("subscription-changed");
    if (events[0].type === "subscription-changed") {
      expect(events[0].name).toBe("attention");
      expect(events[0].value).toBe("main=1 dev=");
    }
  });

  test("handles partial lines across multiple feeds", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%sessions");
    expect(events.length).toBe(0);
    parser.feed("-changed\n");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("sessions-changed");
  });

  test("handles multiple lines in single feed", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%sessions-changed\n%session-changed $1\n");

    expect(events.length).toBe(2);
    expect(events[0].type).toBe("sessions-changed");
    expect(events[1].type).toBe("session-changed");
  });

  test("emits window-renamed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%window-renamed @0 bash\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("window-renamed");
    if (events[0].type === "window-renamed") {
      expect(events[0].args).toBe("@0 bash");
    }
  });

  // The Command Center derives its membership from the whole pane inventory,
  // so a split, a kill or an active-pane move has to reach it. Both of these
  // used to fall through to the "ignore unknown % lines" tail.
  test("emits layout-change notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%layout-change @1 b25d,80x24,0,0,1 b25d,80x24,0,0,1 *\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("layout-change");
    if (events[0].type === "layout-change") {
      expect(events[0].args).toBe("@1 b25d,80x24,0,0,1 b25d,80x24,0,0,1 *");
    }
  });

  test("emits window-pane-changed notification", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%window-pane-changed @2 %7\n");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("window-pane-changed");
    if (events[0].type === "window-pane-changed") {
      expect(events[0].args).toBe("@2 %7");
    }
  });

  test("layout-change does not shadow window-renamed or window-close", () => {
    const parser = new ControlParser();
    const events: ControlEvent[] = [];
    parser.onEvent((e) => events.push(e));

    parser.feed("%window-close @3\n");
    parser.feed("%layout-change @1 x x *\n");
    parser.feed("%window-renamed @1 zsh\n");

    expect(events.map((e) => e.type)).toEqual([
      "window-close",
      "layout-change",
      "window-renamed",
    ]);
  });
});
