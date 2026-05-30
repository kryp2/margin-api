import { canonicalizeUrl, toContextUrn, InvalidUrlError } from "../src/lib/urlCanon";

/**
 * Unit tests for the URL canonicalizer. The canonical form is what becomes the
 * on-chain `context=url:<canonical>` anchor, so two requests that refer to the
 * same resource MUST canonicalize identically — otherwise their comments split
 * across separate anchors and never thread together.
 */
describe("canonicalizeUrl", () => {
    describe("fragment stripping", () => {
        it("drops a #fragment so it does not fork the context anchor", () => {
            expect(canonicalizeUrl("https://example.com/article#comments"))
                .toBe("https://example.com/article");
        });

        it("with and without a fragment produce the SAME canonical URL", () => {
            expect(canonicalizeUrl("https://example.com/article#comments"))
                .toBe(canonicalizeUrl("https://example.com/article"));
        });

        it("drops a bare trailing '#'", () => {
            expect(canonicalizeUrl("https://example.com/a#"))
                .toBe("https://example.com/a");
        });

        it("strips the fragment even when a query is present", () => {
            expect(canonicalizeUrl("https://example.com/a?b=2#sec"))
                .toBe("https://example.com/a?b=2");
        });

        it("strips both a tracking param and the fragment", () => {
            expect(canonicalizeUrl("https://example.com/a?utm_source=x#sec"))
                .toBe("https://example.com/a");
        });
    });

    describe("existing behavior (regression guards)", () => {
        it("lowercases scheme and host", () => {
            expect(canonicalizeUrl("HTTPS://Example.COM/Path"))
                .toBe("https://example.com/Path");
        });

        it("strips default ports", () => {
            expect(canonicalizeUrl("https://example.com:443/x"))
                .toBe("https://example.com/x");
            expect(canonicalizeUrl("http://example.com:80/x"))
                .toBe("http://example.com/x");
        });

        it("removes known tracking params and sorts the rest", () => {
            expect(canonicalizeUrl("https://example.com/x?b=2&utm_source=n&a=1"))
                .toBe("https://example.com/x?a=1&b=2");
        });

        it("strips userinfo (credentials)", () => {
            expect(canonicalizeUrl("https://user:pass@example.com/x"))
                .toBe("https://example.com/x");
        });

        it("trims a trailing slash on non-root paths", () => {
            expect(canonicalizeUrl("https://example.com/foo/"))
                .toBe("https://example.com/foo");
        });

        it("rejects non-http(s) schemes", () => {
            expect(() => canonicalizeUrl("javascript:alert(1)")).toThrow(InvalidUrlError);
        });

        it("rejects empty input", () => {
            expect(() => canonicalizeUrl("")).toThrow(InvalidUrlError);
        });
    });
});

describe("toContextUrn", () => {
    it("prefixes the canonical URL with 'url:' and drops the fragment", () => {
        expect(toContextUrn("https://example.com/article#comments"))
            .toBe("url:https://example.com/article");
    });
});
