import { describe, test, expect } from "bun:test";
import { ReconcileLoop } from "../../glass/reconcile-loop";

/**
 * A hand-driven scheduler: nothing runs until `flushScheduled()` is called, so
 * a test can place an invalidation in the exact window it means to exercise.
 */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => { queue.push(fn); },
    /** Run everything queued so far (not what those runs queue in turn). */
    flushScheduled: () => {
      const batch = queue.splice(0);
      for (const fn of batch) fn();
    },
    pending: () => queue.length,
  };
}

/** A read that resolves only when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ReconcileLoop", () => {
  test("a burst of invalidations in one tick produces one run", async () => {
    const sched = manualScheduler();
    let runs = 0;
    const loop = new ReconcileLoop({
      run: async () => { runs++; },
      onError: () => {},
      schedule: sched.schedule,
    });

    for (let i = 0; i < 10; i++) loop.invalidate();
    expect(sched.pending()).toBe(1);

    sched.flushScheduled();
    await Promise.resolve();
    expect(runs).toBe(1);
  });

  test("an invalidation while in flight causes exactly one follow-up run", async () => {
    const sched = manualScheduler();
    const gates = [deferred<void>(), deferred<void>()];
    let runs = 0;
    const loop = new ReconcileLoop({
      run: () => gates[runs++]!.promise,
      onError: () => {},
      schedule: sched.schedule,
    });

    loop.invalidate();
    sched.flushScheduled();
    expect(runs).toBe(1); // in flight, snapshot taken

    // Three invalidations arrive during the read. All three describe the same
    // world the run in flight cannot see — they must collapse into one rerun,
    // not three, and not zero.
    loop.invalidate();
    loop.invalidate();
    loop.invalidate();
    expect(sched.pending()).toBe(0); // queued as `dirty`, not as a schedule

    gates[0]!.resolve();
    await gates[0]!.promise;
    await Promise.resolve();

    expect(sched.pending()).toBe(1);
    sched.flushScheduled();
    expect(runs).toBe(2);

    gates[1]!.resolve();
    await gates[1]!.promise;
    await Promise.resolve();
    expect(sched.pending()).toBe(0); // nothing arrived during the second run
  });

  test("a throwing read clears inFlight and still reschedules a pending dirty", async () => {
    const sched = manualScheduler();
    const gate = deferred<void>();
    let runs = 0;
    const errors: unknown[] = [];
    const loop = new ReconcileLoop({
      run: () => { runs++; return runs === 1 ? gate.promise : Promise.resolve(); },
      onError: (e) => { errors.push(e); },
      schedule: sched.schedule,
    });

    loop.invalidate();
    sched.flushScheduled();
    loop.invalidate(); // arrives while the doomed read is in flight

    gate.reject(new Error("tmux went away"));
    await gate.promise.catch(() => {});
    await Promise.resolve();

    expect(errors.length).toBe(1);
    expect(sched.pending()).toBe(1);
    sched.flushScheduled();
    expect(runs).toBe(2);
  });

  test("a throwing read does not wedge later invalidations", async () => {
    const sched = manualScheduler();
    let runs = 0;
    const loop = new ReconcileLoop({
      run: async () => { runs++; throw new Error("boom"); },
      onError: () => {},
      schedule: sched.schedule,
    });

    for (let i = 0; i < 3; i++) {
      loop.invalidate();
      sched.flushScheduled();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(runs).toBe(3);
  });

  test("flush resolves only after a run that started after it was called", async () => {
    const sched = manualScheduler();
    const gates = [deferred<void>(), deferred<void>()];
    let runs = 0;
    const loop = new ReconcileLoop({
      run: () => gates[runs++]!.promise,
      onError: () => {},
      schedule: sched.schedule,
    });

    loop.invalidate();
    sched.flushScheduled();
    expect(runs).toBe(1);

    let flushed = false;
    void loop.flush().then(() => { flushed = true; });

    // The in-flight run's snapshot predates the flush, so finishing it must
    // not resolve the flush — only the rerun it schedules can.
    gates[0]!.resolve();
    await gates[0]!.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    sched.flushScheduled();
    expect(runs).toBe(2);
    gates[1]!.resolve();
    await gates[1]!.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(true);
  });

  test("flush with an idle loop resolves on the run it schedules", async () => {
    const sched = manualScheduler();
    let runs = 0;
    const loop = new ReconcileLoop({
      run: async () => { runs++; },
      onError: () => {},
      schedule: sched.schedule,
    });

    let flushed = false;
    void loop.flush().then(() => { flushed = true; });
    expect(sched.pending()).toBe(1);
    sched.flushScheduled();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(flushed).toBe(true);
  });

  test("the default scheduler is a microtask", async () => {
    let runs = 0;
    const loop = new ReconcileLoop({
      run: async () => { runs++; },
      onError: () => {},
    });
    loop.invalidate();
    expect(runs).toBe(0); // not synchronous
    await Promise.resolve();
    expect(runs).toBe(1);
  });
});
