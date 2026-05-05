/**
 * margin-api configuration.
 *
 * All knobs come from environment variables. No file-based config — Cloud Run
 * mounts secrets as env, which is what we use.
 */

export interface Config {
    port: number;
    wabBaseUrl: string;
    overlayBaseUrl: string;
    overlayTopic: string;
    network: "main" | "test";
    appName: string;
    /** comma-separated list of allowed CORS origins; "*" allows all */
    corsOrigins: string;
}

export function loadConfig(): Config {
    const network = process.env.BSV_NETWORK ?? "main";
    if (network !== "main" && network !== "test") {
        throw new Error(`BSV_NETWORK must be "main" or "test", got "${network}"`);
    }
    return {
        port: parseInt(process.env.PORT ?? "8080", 10),
        wabBaseUrl: process.env.WAB_BASE_URL ?? "https://wab.peck.to",
        overlayBaseUrl: process.env.OVERLAY_BASE_URL ?? "https://overlay.peck.to",
        overlayTopic: process.env.OVERLAY_TOPIC ?? "peck-schema",
        network,
        appName: process.env.MARGIN_APP_NAME ?? "margin",
        corsOrigins: process.env.CORS_ORIGINS ?? "*",
    };
}
