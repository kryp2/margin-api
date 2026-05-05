import { buildApp } from "./app";
import { loadConfig } from "./config";
import { loadSponsorWalletFromEnv } from "./services/SponsorWallet";

const config = loadConfig();
const sponsor = loadSponsorWalletFromEnv();
const app = buildApp(config, { sponsor });

if (sponsor) {
    console.log(`[margin-api] sponsor=${sponsor.address()} balance=${sponsor.currentBalance()} sat`);
} else {
    console.log("[margin-api] no sponsor wallet configured — /post returns 503");
}

app.listen(config.port, () => {
    console.log(`[margin-api] listening on :${config.port} (network=${config.network}, wab=${config.wabBaseUrl}, overlay=${config.overlayBaseUrl})`);
});
