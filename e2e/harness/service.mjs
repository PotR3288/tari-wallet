// The x402 paywalled merchant service (Phase 5 e2e, Task 5.2a): a trivial HTTP server that
// answers `GET /protected` with a 402 payment-required signal and serves the resource only once
// the purchase is settled. The wire dialect is env-selectable (X402_SERVICE_WIRE_DIALECT):
// "v2" (default) emits the foundation x402 v2 PaymentRequired base64-encoded in the
// PAYMENT-REQUIRED header — the spec's canonical HTTP form (specs/transports-v2/http.md), with
// the Ootle terms as scheme-specific extra keys and no network field until the tari:* CAIP-2
// namespace is registered; "legacy" keeps the flat quote in the JSON body for transition-period
// regression runs. It plays the MERCHANT: it mints the
// claim secret (preimage + hashLock), it is the party whose wallet address is the quote's
// `claimantAddress`, and -- per docs/x402-facilitator.md's frozen settlement ordering
// (merchant-initiated hold-then-broadcast) -- IT posts the signed claim the merchant wallet
// produced to the facilitator:
//
//   payer funds (x402Pay)  ->  merchant wallet signs claim (x402SignClaim, in the extension)
//   ->  this service POSTs /x402/settle  ->  facilitator validates + HOLDS (`held`)
//   ->  this service marks the purchase paid and serves the resource
//   ->  this service confirms settle (POST /broadcast)  ->  facilitator broadcasts the claim
//   ->  `broadcast` -> `confirmed` (chainTxId set).
//
// Ordering note (deliberate): the resource is served while the payload is still HELD, before the
// broadcast -- that is the spec's chosen ordering ("validate + HOLD ... serve resource ...
// merchant confirms settle; the indexer broadcasts"). The hold window is exactly what lets the
// refund scenario (frozen facilitator: held, never broadcast) still serve and then refund.
//
// The claim signing itself is NOT done here -- it is done by the merchant's wallet (the second
// built-extension instance, driven by run.ts); this service only receives the sealed payload and
// relays it. The optional test-only deviations of the facilitator stand-in (preimageHex,
// claimantViewKeyHex) ride along: the preimage is this service's own claim secret, and the view
// key is supplied by the harness runner (which derives it offline from the deterministic
// merchant seed) in the /merchant/claim body.
//
// One purchase per process: the harness spawns a fresh service per scenario, so no state can
// leak between the happy-path and refund runs.
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.env.X402_SERVICE_PORT ?? 4021);
const INDEXER_URL = process.env.X402_INDEXER_URL ?? "https://ootle-indexer-a.tari.com";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "http://127.0.0.1:4020";
const CLAIMANT_ADDRESS = process.env.X402_SERVICE_CLAIMANT_ADDRESS ?? "";
const RESOURCE_URL = process.env.X402_SERVICE_RESOURCE_URL ?? `http://127.0.0.1:${PORT}/protected`;
const REFUND_EPOCH_OFFSET = Number(process.env.X402_SERVICE_REFUND_EPOCH_OFFSET ?? 8);
/** 1 = the refund scenario: settle is held, never broadcast (the "frozen facilitator" leg). */
const FREEZE_BROADCAST = process.env.X402_SERVICE_FREEZE_BROADCAST === "1";
const AMOUNT = process.env.X402_SERVICE_AMOUNT ?? "1000";
/** Wire dialect for the 402 answer: "v2" (default) = base64 foundation v2 PaymentRequired in the PAYMENT-REQUIRED header; "legacy" = flat quote in the JSON body. */
const WIRE_DIALECT = process.env.X402_SERVICE_WIRE_DIALECT ?? "v2";
const QUOTE_TTL_MS = Number(process.env.X402_SERVICE_QUOTE_TTL_MS ?? 30 * 60 * 1000);
const RESOURCE_BODY =
  process.env.X402_SERVICE_RESOURCE_BODY ?? "You paid for this sentence. (x402 over Tari Ootle, live esmeralda e2e)";

// XTR on esmeralda/igor (src/lib/daemonAccount.ts's TARI_RESOURCE_ADDRESS, copied so this file
// stays dependency-free plain Node).
const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";

if (!CLAIMANT_ADDRESS) {
  console.error("service: X402_SERVICE_CLAIMANT_ADDRESS (the merchant wallet's otl_ address) is required");
  process.exit(1);
}
if (!["v2", "legacy"].includes(WIRE_DIALECT)) {
  console.error(`service: X402_SERVICE_WIRE_DIALECT must be "v2" or "legacy" (got ${WIRE_DIALECT})`);
  process.exit(1);
}

/** One purchase, created lazily on the first unpaid GET /protected. */
const purchase = {
  quote: null,
  preimageHex: null,
  paid: false,
  localDigest: null,
  settlementStatus: null,
  chainTxId: null,
};

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function currentEpoch() {
  const res = await fetch(`${INDEXER_URL}/network/stats`);
  if (!res.ok) throw new Error(`indexer stats HTTP ${res.status}`);
  const body = await res.json();
  const epoch = body?.network_desc?.epoch;
  if (typeof epoch !== "number") throw new Error(`indexer stats carried no epoch: ${JSON.stringify(body).slice(0, 200)}`);
  return epoch;
}

async function newQuote() {
  const preimage = randomBytes(32);
  const refundEpoch = (await currentEpoch()) + REFUND_EPOCH_OFFSET;
  return {
    preimageHex: preimage.toString("hex"),
    quote: {
      resourceUrl: RESOURCE_URL,
      amount: AMOUNT,
      resourceAddress: TARI_RESOURCE_ADDRESS,
      claimantAddress: CLAIMANT_ADDRESS,
      hashLockHex: sha256Hex(preimage),
      refundEpoch,
      facilitatorUrl: FACILITATOR_URL,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function respond(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(
    status,
    { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), ...extraHeaders }
  );
  res.end(json);
}

/** POST the facilitator's /x402/settle and record the hold. Throws on any non-`held` answer. */
async function settleClaim({ signedClaim, conditions, claimantViewKeyHex }) {
  const settleBody = {
    signedPayloadHex: signedClaim.signedPayloadHex,
    quote: purchase.quote,
    htlcOutputCommitmentHex: signedClaim.htlcOutputCommitment,
    conditions,
    validUntilEpoch: signedClaim.validUntilEpoch,
    preimageHex: purchase.preimageHex,
    claimantViewKeyHex,
  };
  const res = await fetch(`${FACILITATOR_URL}/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settleBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.status === undefined) {
    throw new Error(`facilitator settle HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  purchase.localDigest = body.localDigest;
  purchase.settlementStatus = body.status;
  if (body.txHash) purchase.chainTxId = body.txHash;
  if (body.status !== "held") {
    throw new Error(`facilitator settle returned status ${body.status}, expected held`);
  }
}

/** The merchant's settle confirmation: trigger the facilitator's broadcast. */
async function confirmSettle() {
  const res = await fetch(`${FACILITATOR_URL}/x402/settlement/${purchase.localDigest}/broadcast`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`facilitator broadcast HTTP ${res.status}: ${JSON.stringify(body)}`);
  purchase.settlementStatus = body.status;
  if (body.txHash) purchase.chainTxId = body.txHash;
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    try {
      // The paywalled resource. 402 + quote until paid; the resource after.
      if (req.method === "GET" && url.pathname === "/protected") {
        if (!purchase.paid && !purchase.quote) {
          const { quote, preimageHex } = await newQuote();
          purchase.quote = quote;
          purchase.preimageHex = preimageHex;
          console.log(`service: quoted ${AMOUNT} XTR base units, refundEpoch ${quote.refundEpoch}, hashLock ${quote.hashLockHex}`);
        }
        if (!purchase.paid) {
          if (WIRE_DIALECT === "v2") {
            // Foundation x402 v2 wire form: the PaymentRequired object rides base64-encoded in
            // the PAYMENT-REQUIRED header; response bodies are a server implementation concern.
            const v2 = {
              x402Version: 2,
              resource: { url: RESOURCE_URL },
              accepts: [
                {
                  scheme: "exact",
                  amount: AMOUNT,
                  asset: TARI_RESOURCE_ADDRESS,
                  payTo: CLAIMANT_ADDRESS,
                  maxTimeoutSeconds: Math.floor(QUOTE_TTL_MS / 1000),
                  extra: {
                    hashLockHex: purchase.quote.hashLockHex,
                    refundEpoch: purchase.quote.refundEpoch,
                    facilitatorUrl: FACILITATOR_URL,
                    expiresAt: purchase.quote.expiresAt,
                    paymentFlow: "escrow",
                  },
                },
              ],
            };
            respond(res, 402, { error: "PAYMENT_REQUIRED" }, {
              "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(v2), "utf8").toString("base64"),
            });
          } else {
            // Legacy flat dialect (transition-period regression): the quote in the JSON body.
            respond(res, 402, { error: "PAYMENT_REQUIRED", quote: purchase.quote });
          }
          return;
        }
        respond(res, 200, { body: RESOURCE_BODY });
        return;
      }

      // Harness/merchant-side routes (same-origin: the merchant wallet's dApp page and the
      // runner fetch these; the payer never does).
      if (req.method === "GET" && url.pathname === "/merchant/state") {
        respond(res, 200, {
          quote: purchase.quote,
          preimageHex: purchase.preimageHex,
          paid: purchase.paid,
          settlementStatus: purchase.settlementStatus,
          chainTxId: purchase.chainTxId,
        });
        return;
      }

      // The merchant wallet's signed claim, relayed by the runner. Settles per the spec's
      // ordering: validate+hold -> serve (mark paid) -> confirm settle (broadcast) unless frozen.
      if (req.method === "POST" && url.pathname === "/merchant/claim") {
        if (!purchase.quote) throw new Error("No quote was issued yet -- fetch /protected first.");
        const body = await readBody(req);
        const { signedClaim, conditions, claimantViewKeyHex } = body ?? {};
        if (!signedClaim?.signedPayloadHex || !Array.isArray(conditions)) {
          throw new Error("merchant/claim needs { signedClaim, conditions, claimantViewKeyHex }");
        }
        await settleClaim({ signedClaim, conditions, claimantViewKeyHex });
        console.log(`service: facilitator HELD the claim (localDigest ${purchase.localDigest})`);
        purchase.paid = true; // serve the resource while the payload is held -- spec ordering
        if (FREEZE_BROADCAST) {
          console.log("service: FREEZE_BROADCAST=1 -- never confirming settle; the claim stays held forever");
          respond(res, 200, { status: purchase.settlementStatus, localDigest: purchase.localDigest, frozen: true });
          return;
        }
        await confirmSettle();
        console.log(`service: settlement ${purchase.settlementStatus}, chainTxId ${purchase.chainTxId}`);
        respond(res, 200, { status: purchase.settlementStatus, localDigest: purchase.localDigest, chainTxId: purchase.chainTxId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/merchant/settlement") {
        if (!purchase.localDigest) throw new Error("Nothing has been settled yet.");
        const out = await fetch(`${FACILITATOR_URL}/x402/settlement/${purchase.localDigest}`);
        const body = await out.json().catch(() => ({}));
        if (!out.ok) throw new Error(`facilitator settlement HTTP ${out.status}: ${JSON.stringify(body)}`);
        purchase.settlementStatus = body.status;
        if (body.txHash) purchase.chainTxId = body.txHash;
        respond(res, 200, { status: purchase.settlementStatus, chainTxId: purchase.chainTxId, localDigest: purchase.localDigest });
        return;
      }

      respond(res, 404, { error: "NOT_FOUND", detail: `${req.method} ${url.pathname}` });
    } catch (e) {
      respond(res, 500, { error: "INTERNAL", detail: e instanceof Error ? e.message : String(e) });
    }
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `x402 merchant service listening on http://127.0.0.1:${PORT} ` +
      `(claimant ${CLAIMANT_ADDRESS.slice(0, 24)}..., refundEpoch +${REFUND_EPOCH_OFFSET}, freeze=${FREEZE_BROADCAST}, wire=${WIRE_DIALECT}, indexer ${INDEXER_URL})`
  );
});
