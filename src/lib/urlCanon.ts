/**
 * URL canonicalization for Margin's `context=url:<canonical>` anchor.
 *
 * Implements margin/SPEC.md §4.3. Pure — no network. Callers handle
 * redirect caching above this layer.
 *
 * Inlined from @margin/url-canon for Cloud Run deploy convenience (file:
 * dependencies don't carry through Cloud Build context cleanly). If a
 * second consumer ever needs this code, extract back to a shared package.
 */

import { createHash } from "crypto";

const MAX_URL_LENGTH = 2000;

const TRACKING_PARAMS: ReadonlySet<string> = new Set([
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "fbclid", "msclkid", "mc_eid", "_ga",
    "ref", "referrer",
]);

export class InvalidUrlError extends Error {
    constructor(input: string, reason: string) {
        super(`Invalid URL "${input}": ${reason}`);
        this.name = "InvalidUrlError";
    }
}

export interface CanonicalizeOptions {
    /** Extra query keys to strip beyond the built-in tracking list. */
    extraStripParams?: Iterable<string>;
}

export function canonicalizeUrl(input: string, opts: CanonicalizeOptions = {}): string {
    if (typeof input !== "string" || input.length === 0) {
        throw new InvalidUrlError(input, "must be a non-empty string");
    }

    let parsed: URL;
    try {
        parsed = new URL(input.trim());
    } catch {
        throw new InvalidUrlError(input, "not parseable as a URL");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new InvalidUrlError(input, `unsupported scheme ${parsed.protocol}`);
    }

    parsed.username = "";
    parsed.password = "";

    const stripSet = new Set<string>(TRACKING_PARAMS);
    if (opts.extraStripParams) {
        for (const k of opts.extraStripParams) stripSet.add(k);
    }
    for (const key of [...parsed.searchParams.keys()]) {
        if (stripSet.has(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();

    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }

    let out = parsed.toString();
    out = out.replace(/\?(?=#|$)/, "");
    return out;
}

export function toContextUrn(input: string, opts: CanonicalizeOptions = {}): string {
    const canonical = canonicalizeUrl(input, opts);
    if (canonical.length > MAX_URL_LENGTH) {
        const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
        return `url:sha256:${hash}`;
    }
    return `url:${canonical}`;
}

export { TRACKING_PARAMS };
