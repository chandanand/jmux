import { describe, expect, test } from "bun:test";
import {
  CELL_SIZE_PROBE,
  GRAPHICS_PROBE,
  GRAPHICS_PROBE_ID,
  cropForVisibleRows,
  encodeDeleteImage,
  encodeDeletePlacement,
  encodePlace,
  encodeTransmit,
  fitImage,
  idBase,
  scanForImageProbe,
} from "../images/kitty";

const GRID = { cols: 80, rows: 24 };

describe("GRAPHICS_PROBE", () => {
  test("is an APC query that asks for a reply", () => {
    expect(GRAPHICS_PROBE.startsWith("\x1b_G")).toBe(true);
    expect(GRAPHICS_PROBE.endsWith("\x1b\\")).toBe(true);
    expect(GRAPHICS_PROBE).toContain("a=q");
    expect(GRAPHICS_PROBE).toContain(`i=${GRAPHICS_PROBE_ID}`);
    // q= suppresses replies; the one command whose reply we want must not have it.
    expect(GRAPHICS_PROBE).not.toContain("q=");
  });

  test("asks for both cell-geometry reports", () => {
    expect(CELL_SIZE_PROBE).toContain("\x1b[16t");
    expect(CELL_SIZE_PROBE).toContain("\x1b[14t");
  });
});

describe("scanForImageProbe", () => {
  test("an OK reply means supported, and is peeled off the stream", () => {
    const scan = scanForImageProbe("", `a\x1b_Gi=31;OK\x1b\\b`, GRID);
    expect(scan.supported).toBe(true);
    expect(scan.forward).toBe("ab");
  });

  test("an error reply means not supported", () => {
    const scan = scanForImageProbe("", `\x1b_Gi=31;ENOTSUPPORTED\x1b\\`, GRID);
    expect(scan.supported).toBe(false);
    expect(scan.forward).toBe("");
  });

  test("a BEL-terminated reply is recognised too", () => {
    expect(scanForImageProbe("", `\x1b_Gi=31;OK\x07`, GRID).supported).toBe(true);
  });

  test("no reply leaves support unknown and input untouched", () => {
    const scan = scanForImageProbe("", "hello\x1b[A", GRID);
    expect(scan.supported).toBeNull();
    expect(scan.forward).toBe("hello\x1b[A");
  });

  test("a split APC reply is held, then resolved on the next chunk", () => {
    const first = scanForImageProbe("", "\x1b_Gi=31;O", GRID);
    expect(first.forward).toBeNull();
    expect(first.supported).toBeNull();
    const second = scanForImageProbe(first.pending, "K\x1b\\rest", GRID);
    expect(second.supported).toBe(true);
    expect(second.forward).toBe("rest");
  });

  test("an APC that never terminates stops being held once it's implausible", () => {
    const scan = scanForImageProbe("", "\x1b_G" + "x".repeat(600), GRID);
    expect(scan.forward).not.toBeNull();
  });

  test("reads cell geometry from a CSI 16 t reply", () => {
    const scan = scanForImageProbe("", "\x1b[6;18;9t", GRID);
    expect(scan.cellPx).toEqual({ w: 9, h: 18 });
    expect(scan.forward).toBe("");
  });

  test("derives cell geometry from a text-area report and the grid size", () => {
    const scan = scanForImageProbe("", "\x1b[4;432;720t", { cols: 80, rows: 24 });
    expect(scan.cellPx).toEqual({ w: 9, h: 18 });
  });

  test("a direct cell report wins over the derived one", () => {
    const scan = scanForImageProbe("", "\x1b[6;20;10t\x1b[4;432;720t", GRID);
    expect(scan.cellPx).toEqual({ w: 10, h: 20 });
    expect(scan.forward).toBe("");
  });

  test("an Escape keypress is never held", () => {
    // Holding a lone ESC waiting for a CSI to complete would cost the user
    // their way out of a screen — the reply is simply missed instead.
    const scan = scanForImageProbe("", "\x1b", GRID);
    expect(scan.forward).toBe("\x1b");
  });
});

describe("encodeTransmit", () => {
  test("sends small images in one chunk with no continuation marker", () => {
    const out = encodeTransmit(7, new Uint8Array([1, 2, 3]));
    expect(out).toBe("\x1b_Ga=t,f=100,t=d,i=7,q=2;AQID\x1b\\");
    expect(out).not.toContain("m=");
  });

  test("chunks large images, marking every chunk but the last as continued", () => {
    // 4096 base64 chars is the chunk size, so 9000 raw bytes (12000 encoded)
    // spans three of them.
    const out = encodeTransmit(7, new Uint8Array(9000));
    const chunks = out.split("\x1b\\").filter((s) => s.length > 0);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toContain("a=t,f=100,t=d,i=7,q=2,m=1;");
    expect(chunks[1].startsWith("\x1b_Gm=1;")).toBe(true);
    expect(chunks[2].startsWith("\x1b_Gm=0;")).toBe(true);
    // Only the first chunk carries control data.
    expect(chunks[1]).not.toContain("a=t");
  });

  test("round-trips the payload through base64", () => {
    const png = new Uint8Array(5000).map((_, i) => i % 256);
    const out = encodeTransmit(9, png);
    const joined = out
      .split("\x1b\\")
      .filter(Boolean)
      .map((c) => c.slice(c.indexOf(";") + 1))
      .join("");
    expect(new Uint8Array(Buffer.from(joined, "base64"))).toEqual(png);
  });
});

describe("encodePlace", () => {
  test("pins the cursor and suppresses the reply", () => {
    const out = encodePlace({ id: 3, placementId: 1, cols: 20, rows: 8 });
    expect(out).toBe("\x1b_Ga=p,i=3,p=1,c=20,r=8,C=1,q=2\x1b\\");
  });

  test("carries the source rectangle when cropped", () => {
    const out = encodePlace({ id: 3, placementId: 2, cols: 20, rows: 4, crop: { x: 0, y: 100, w: 640, h: 200 } });
    expect(out).toContain("x=0,y=100,w=640,h=200");
  });
});

describe("delete commands", () => {
  test("a placement delete keeps the image data", () => {
    expect(encodeDeletePlacement(3, 1)).toBe("\x1b_Ga=d,d=i,i=3,p=1,q=2\x1b\\");
  });

  test("an image delete frees the data", () => {
    expect(encodeDeleteImage(3)).toBe("\x1b_Ga=d,d=I,i=3,q=2\x1b\\");
  });
});

describe("idBase", () => {
  test("different processes get different id namespaces", () => {
    expect(idBase(1234)).not.toBe(idBase(1235));
  });

  test("ids stay positive and inside the protocol's 32-bit range", () => {
    for (const pid of [1, 4242, 0x7fff, 99999]) {
      const base = idBase(pid);
      expect(base).toBeGreaterThan(0);
      expect(base + 10000).toBeLessThan(0x7fffffff);
    }
  });
});

describe("fitImage", () => {
  test("keeps a small image at its natural cell size", () => {
    expect(fitImage({ w: 90, h: 90 }, { w: 9, h: 18 }, 80, 20)).toEqual({ cols: 10, rows: 5 });
  });

  test("never enlarges", () => {
    const box = fitImage({ w: 18, h: 18 }, { w: 9, h: 18 }, 80, 20);
    expect(box).toEqual({ cols: 2, rows: 1 });
  });

  test("shrinks to the width budget, preserving aspect", () => {
    const box = fitImage({ w: 1800, h: 900 }, { w: 9, h: 18 }, 50, 40);
    expect(box.cols).toBe(50);
    // 1800x900 is 200x50 cells; scaled to 50 cols that's 12.5 → 13 rows.
    expect(box.rows).toBe(13);
  });

  test("the row cap wins when it binds first", () => {
    const box = fitImage({ w: 900, h: 1800 }, { w: 9, h: 18 }, 80, 10);
    expect(box.rows).toBe(10);
    expect(box.cols).toBeLessThanOrEqual(80);
  });

  test("a sliver of an image still claims one cell", () => {
    expect(fitImage({ w: 2, h: 2 }, { w: 9, h: 18 }, 80, 20)).toEqual({ cols: 1, rows: 1 });
  });

  test("degenerate input yields no box rather than a division by zero", () => {
    expect(fitImage({ w: 0, h: 0 }, { w: 9, h: 18 }, 80, 20)).toEqual({ cols: 0, rows: 0 });
    expect(fitImage({ w: 10, h: 10 }, { w: 9, h: 18 }, 0, 20)).toEqual({ cols: 0, rows: 0 });
  });
});

describe("cropForVisibleRows", () => {
  test("a fully visible image needs no crop", () => {
    expect(cropForVisibleRows({ w: 640, h: 480 }, 10, 0, 10)).toBeNull();
    expect(cropForVisibleRows({ w: 640, h: 480 }, 10, 0, 25)).toBeNull();
  });

  test("scrolled off the top, the crop starts proportionally down the source", () => {
    expect(cropForVisibleRows({ w: 640, h: 480 }, 10, 4, 6)).toEqual({ x: 0, y: 192, w: 640, h: 288 });
  });

  test("clipped at the bottom, the crop ends early", () => {
    expect(cropForVisibleRows({ w: 640, h: 480 }, 10, 0, 3)).toEqual({ x: 0, y: 0, w: 640, h: 144 });
  });

  test("a middle slice takes the middle of the source", () => {
    expect(cropForVisibleRows({ w: 100, h: 100 }, 4, 1, 2)).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });

  test("a one-row slice of a tall image still has height", () => {
    const crop = cropForVisibleRows({ w: 10, h: 3 }, 100, 50, 1);
    expect(crop!.h).toBeGreaterThanOrEqual(1);
  });
});
