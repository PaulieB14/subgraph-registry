import { AmpChat } from "./AmpChat";
import { Panel } from "@/components/Panel";

export const dynamic = "force-dynamic";

const SUGGESTED = [
  "How many distinct wallets paid The Graph's x402 gateway in the last 24 hours?",
  "What's the average USDC payment size per hour today?",
  "Show the top 5 paying wallets to The Graph all time, with payment count and total USDC.",
  "Which contracts did the most recent paying wallet interact with in the same hour?",
  "How does The Graph's gateway compare to the top 5 other USDC receivers on Base today?",
  "Are the wallets paying The Graph EOAs or contract accounts? Count both.",
];

export default function AmpPage() {
  return (
    <>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Ask <span className="text-accent">Amp</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Natural-language SQL over every Base block, transaction, and log.
          Pre-baked answers are in the{" "}
          <a href="/" className="text-muted underline decoration-accent/40 underline-offset-2 hover:text-accent">
            Watch view
          </a>{" "}
          — this page is for the questions you didn't pre-encode.
        </p>
      </header>

      <Panel title="Conversation" caption="powered by Amp">
        <AmpChat suggestions={SUGGESTED} />
      </Panel>

      <p className="mt-4 text-center text-[11px] text-dim">
        Demo: this page is configured to query the local Amp instance at{" "}
        <code className="font-mono text-muted">localhost:1603</code>. Flip the{" "}
        <code className="font-mono text-muted">AMP_SQL_URL</code> env var when Amp moves to a public host.
      </p>
    </>
  );
}
