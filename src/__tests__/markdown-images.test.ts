import { describe, expect, test } from "bun:test";
import { renderMarkdownBlocks, splitImageChunks } from "../markdown";

const texts = (chunks: ReturnType<typeof splitImageChunks>) =>
  chunks.map((c) => (c.kind === "image" ? `IMG:${c.url}` : c.text.trim()));

describe("splitImageChunks", () => {
  test("lifts a flush-left standalone image out of the prose", () => {
    const out = splitImageChunks("Before\n\n![a shot](https://x/y.png)\n\nAfter");
    expect(texts(out)).toEqual(["Before", "IMG:https://x/y.png", "After"]);
    expect(out[1]).toMatchObject({ kind: "image", alt: "a shot" });
  });

  test("an image with no surrounding prose is the whole document", () => {
    expect(texts(splitImageChunks("![](https://x/y.png)"))).toEqual(["IMG:https://x/y.png"]);
  });

  test("consecutive images each become their own block", () => {
    const out = splitImageChunks("![](https://x/1.png)\n![](https://x/2.png)");
    expect(texts(out)).toEqual(["IMG:https://x/1.png", "IMG:https://x/2.png"]);
  });

  test("an image inside a sentence stays in the prose", () => {
    const out = splitImageChunks("see ![a](https://x/y.png) here");
    expect(texts(out)).toEqual(["see ![a](https://x/y.png) here"]);
  });

  test("a badge wrapped in a link stays in the prose", () => {
    // The outer page URL is the useful target; the existing linkify rule keeps
    // it, and lifting the image would throw it away.
    const src = "[![build](https://x/badge.svg)](https://ci.example)";
    expect(texts(splitImageChunks(src))).toEqual([src]);
  });

  test("an indented image stays put, because the cut wouldn't be free", () => {
    // Splitting here would break the list into two lists.
    const src = "- item\n  ![a](https://x/y.png)\n- next";
    expect(texts(splitImageChunks(src))).toEqual([src]);
  });

  test("an image inside a fenced code block is example text, not an image", () => {
    const src = "```md\n![a](https://x/y.png)\n```";
    expect(texts(splitImageChunks(src))).toEqual([src]);
  });

  test("a fence closes only on a fence of its own kind and length", () => {
    const src = "````\n```\n![a](https://x/y.png)\n````\n\n![b](https://x/z.png)";
    const out = splitImageChunks(src);
    expect(out.filter((c) => c.kind === "image").map((c) => (c as { url: string }).url)).toEqual([
      "https://x/z.png",
    ]);
  });

  test("an unclosed fence swallows the rest of the document", () => {
    const out = splitImageChunks("```\n![a](https://x/y.png)");
    expect(out.every((c) => c.kind === "text")).toBe(true);
  });

  test("an HTML img tag on its own line counts", () => {
    const out = splitImageChunks(`<img width="600" alt="pasted" src="https://x/y.png">`);
    expect(out).toEqual([{ kind: "image", url: "https://x/y.png", alt: "pasted" }]);
  });

  test("an img tag inside a paragraph does not", () => {
    const src = `text <img src="https://x/y.png"> more`;
    expect(texts(splitImageChunks(src))).toEqual([src]);
  });

  test("whitespace-only text between two images is dropped", () => {
    const out = splitImageChunks("![](https://x/1.png)\n\n\n![](https://x/2.png)");
    expect(out.length).toBe(2);
  });

  test("an image line with trailing text is not standalone", () => {
    const src = "![a](https://x/y.png) caption";
    expect(texts(splitImageChunks(src))).toEqual([src]);
  });
});

describe("renderMarkdownBlocks", () => {
  test("without extraction it is one block, identical to the plain render", () => {
    const blocks = renderMarkdownBlocks("Before\n\n![a](https://x/y.png)\n\nAfter", 60);
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe("lines");
    const text = (blocks[0] as { lines: { text: string }[][] }).lines
      .map((l) => l.map((s) => s.text).join(""))
      .join("\n");
    // Falls back to the link rewrite the linkify rule has always produced.
    expect(text).toContain("a");
    expect(text).not.toContain("![");
  });

  test("with extraction the image is its own block between rendered prose", () => {
    const blocks = renderMarkdownBlocks("Before\n\n![a](https://x/y.png)\n\nAfter", 60, {
      extractImages: true,
    });
    expect(blocks.map((b) => b.kind)).toEqual(["lines", "image", "lines"]);
    expect(blocks[1]).toMatchObject({ url: "https://x/y.png", alt: "a" });
  });

  test("empty input renders nothing either way", () => {
    expect(renderMarkdownBlocks("", 60, { extractImages: true })).toEqual([]);
    expect(renderMarkdownBlocks("hi", 0, { extractImages: true })).toEqual([]);
  });

  test("a document that is only an image has no empty prose blocks around it", () => {
    const blocks = renderMarkdownBlocks("![a](https://x/y.png)", 60, { extractImages: true });
    expect(blocks.map((b) => b.kind)).toEqual(["image"]);
  });
});
