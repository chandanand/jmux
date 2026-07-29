import { describe, expect, test } from "bun:test";
import { authHeadersFor, isFetchableImageUrl } from "../images/auth";

const ENV = {
  LINEAR_API_KEY: "lin_key",
  GH_TOKEN: "gh_key",
  GITLAB_TOKEN: "gl_key",
};

describe("authHeadersFor", () => {
  test("sends the Linear key to Linear's upload host", () => {
    expect(authHeadersFor("https://uploads.linear.app/a/b.png", ENV)).toEqual({
      Authorization: "lin_key",
    });
  });

  test("sends a bearer token to GitHub's attachment hosts", () => {
    expect(authHeadersFor("https://user-images.githubusercontent.com/a.png", ENV)).toEqual({
      Authorization: "Bearer gh_key",
    });
    expect(authHeadersFor("https://github.com/o/r/assets/1", ENV)).toEqual({
      Authorization: "Bearer gh_key",
    });
  });

  test("sends the GitLab token to gitlab.com by default", () => {
    expect(authHeadersFor("https://gitlab.com/u/p/uploads/x.png", ENV)).toEqual({
      "PRIVATE-TOKEN": "gl_key",
    });
  });

  test("honours a self-hosted GitLab host", () => {
    const env = { ...ENV, GITLAB_HOST: "https://git.internal.example/" };
    expect(authHeadersFor("https://git.internal.example/u/p/uploads/x.png", env)).toEqual({
      "PRIVATE-TOKEN": "gl_key",
    });
    expect(authHeadersFor("https://gitlab.com/u/p/uploads/x.png", env)).toEqual({});
  });

  test("an unknown host gets no credential at all", () => {
    expect(authHeadersFor("https://cdn.example.com/a.png", ENV)).toEqual({});
  });

  test("a lookalike host is a different host, not a prefix match", () => {
    // The URLs come out of issue text, which anyone who can comment can write.
    expect(authHeadersFor("https://linear.app.evil.net/a.png", ENV)).toEqual({});
    expect(authHeadersFor("https://gitlab.com.evil.net/a.png", ENV)).toEqual({});
    expect(authHeadersFor("https://evil.net/?x=github.com", ENV)).toEqual({});
    expect(authHeadersFor("https://notgithub.com/a.png", ENV)).toEqual({});
  });

  test("credentials never travel over plain http", () => {
    expect(authHeadersFor("http://uploads.linear.app/a.png", ENV)).toEqual({});
  });

  test("subdomains of a credentialed host still qualify", () => {
    expect(authHeadersFor("https://a.b.linear.app/x.png", ENV)).toEqual({
      Authorization: "lin_key",
    });
  });

  test("no token means no header, not an empty one", () => {
    expect(authHeadersFor("https://uploads.linear.app/a.png", {})).toEqual({});
  });

  test("an unparseable URL yields nothing rather than throwing", () => {
    expect(authHeadersFor("not a url", ENV)).toEqual({});
  });
});

describe("isFetchableImageUrl", () => {
  test("accepts http and https", () => {
    expect(isFetchableImageUrl("https://example.com/a.png")).toBe(true);
    expect(isFetchableImageUrl("http://example.com/a.png")).toBe(true);
  });

  test("rejects schemes that would read the local machine", () => {
    expect(isFetchableImageUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableImageUrl("data:image/png;base64,AAAA")).toBe(false);
  });

  test("rejects a relative path", () => {
    expect(isFetchableImageUrl("/images/a.png")).toBe(false);
  });
});
