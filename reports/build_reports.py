#!/usr/bin/env python3
"""Build the two x402-over-Ootle PDFs (general explainer + Sapient-developer brief)."""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                PageBreak, KeepTogether, Flowable)
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon
from reportlab.graphics import renderPDF

INK = colors.HexColor("#16202b")
BODY = colors.HexColor("#333a44")
MUTED = colors.HexColor("#6b7684")
ACCENT = colors.HexColor("#5b2e91")
ACCENT_BG = colors.HexColor("#f2edf9")
LINE = colors.HexColor("#d8dce3")
GREEN = colors.HexColor("#1e7f4f")
AMBER = colors.HexColor("#b7791f")
BOX = colors.HexColor("#f7f8fa")

def S(name, **kw):
    base = dict(fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=BODY,
                alignment=TA_LEFT, spaceAfter=5)
    base.update(kw)
    return ParagraphStyle(name, **base)

STY = {
    "h1": S("h1", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=INK, spaceBefore=14, spaceAfter=7),
    "h2": S("h2", fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=ACCENT, spaceBefore=11, spaceAfter=4),
    "h3": S("h3", fontName="Helvetica-Bold", fontSize=10.3, leading=13, textColor=INK, spaceBefore=8, spaceAfter=3),
    "body": S("body"),
    "bullet": S("bullet", leftIndent=14, bulletIndent=4, spaceAfter=3),
    "small": S("small", fontSize=8.2, leading=11, textColor=MUTED),
    "callout": S("callout", fontSize=9, leading=12.5, textColor=INK),
    "mono": S("mono", fontName="Courier", fontSize=8.4, leading=11.5, textColor=INK),
    "cover_t": S("cover_t", fontName="Helvetica-Bold", fontSize=30, leading=36, textColor=INK),
    "cover_s": S("cover_s", fontSize=13, leading=18, textColor=MUTED),
}

def P(text, style="body", bullet=None):
    p = Paragraph(text, STY[style])
    if bullet:
        p = Paragraph(f"<bullet>&bull;</bullet>{text}", STY[style])
    return p

def callout(text, color=ACCENT):
    t = Table([[Paragraph(text, STY["callout"])]], colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT_BG),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, color),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
    ]))
    return t

def dtable(headers, rows, widths, fs=8.3):
    data = [[Paragraph(f"<b>{h}</b>", S("th", fontSize=fs, textColor=colors.white, leading=fs+2.5)) for h in headers]]
    for r in rows:
        data.append([Paragraph(str(c), S("td", fontSize=fs, leading=fs+2.5)) for c in r])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, BOX]),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t

def rule():
    t = Table([[""]], colWidths=[None], rowHeights=[0.8])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.8, LINE)]))
    return t

# ---------------------------------------------------------------- diagrams

def arrow(d, x1, y1, x2, y2, color=MUTED, dashed=False):
    d.add(Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=1.0,
               strokeDashArray=[2.5, 2.5] if dashed else None))
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    for da in (2.6, -2.6):
        d.add(Polygon([x2, y2, x2 - 6 * math.cos(ang - da), y2 - 6 * math.sin(ang - da)],
                      fillColor=color, strokeColor=None))

def lane_box(d, x, y, w, h, title, sub, fill=colors.white, stroke=INK):
    d.add(Rect(x, y, w, h, fillColor=fill, strokeColor=stroke, strokeWidth=1.1, rx=4, ry=4))
    d.add(String(x + w / 2, y + h / 2 + 3.5, title, fontName="Helvetica-Bold",
                 fontSize=8.6, textAnchor="middle", fillColor=INK))
    if sub:
        d.add(String(x + w / 2, y + h / 2 - 8, sub, fontName="Helvetica",
                     fontSize=7.2, textAnchor="middle", fillColor=MUTED))

def step_label(d, x, y, n, text, color=ACCENT, width=118):
    d.add(String(x, y, f"{n}.  {text}", fontName="Helvetica-Bold", fontSize=7.4, fillColor=color))

def diagram_flow(width=505, height=350, refund=True):
    """Sequence diagram: 4 lifelines, numbered messages."""
    d = Drawing(width, height)
    lane_w, lane_h = 116, 30
    xs = [10, 142, 274, 388]
    centers = [x + lane_w / 2 for x in xs]
    top = height - 10
    titles = [("Client (dApp)", "browser + client pkg"),
              ("Sapient wallet", "window.tari, on-device keys"),
              ("Merchant service", "HTTP resource"),
              ("Indexer facilitator", "Ootle indexer + chain")]
    for x, (t, s) in zip(xs, titles):
        lane_box(d, x, top - lane_h, lane_w, lane_h, t, s,
                 fill=ACCENT_BG if "Indexer" in t or "Sapient" in t else colors.white)
    bottom = 34
    for c in centers:
        d.add(Line(c, top - lane_h, c, bottom, strokeColor=LINE, strokeWidth=0.9,
                   strokeDashArray=[2, 3]))
    y0 = top - lane_h - 26
    dy = 27
    def msg(y, a, b, label, color=MUTED, dashed=False, num=None, label_dy=5):
        arrow(d, centers[a], y, centers[b], y, color=color, dashed=dashed)
        lx = (centers[a] + centers[b]) / 2
        txt = f"{num}.  {label}" if num else label
        d.add(String(lx, y + label_dy, txt, fontName="Helvetica-Bold", fontSize=7.2,
                     textAnchor="middle", fillColor=color))
    msg(y0, 0, 2, "GET /protected  ->  402 + quote", num=1)
    msg(y0 - dy, 0, 1, "x402Pay: approve -> HTLC funded", color=ACCENT, num=2)
    msg(y0 - 2 * dy, 1, 2, "commitment + outputMask relayed (out of band)", dashed=True)
    msg(y0 - 3 * dy, 2, 1, "x402SignClaim: sign-only seal (never broadcast)", color=ACCENT, num=3)
    msg(y0 - 4 * dy, 2, 3, "POST /x402/settle  ->  HELD", num=4)
    # serve: note box on merchant lifeline
    ys = y0 - 5 * dy
    d.add(Rect(centers[2] - 62, ys - 6, 124, 16, fillColor=colors.white, strokeColor=GREEN, strokeWidth=0.9, rx=3, ry=3))
    d.add(String(centers[2], ys, "5.  resource served (HTTP 200)", fontName="Helvetica-Bold",
                 fontSize=7.2, textAnchor="middle", fillColor=GREEN))
    # broadcast: facilitator downward note
    yb = ys - 24
    arrow(d, centers[3], yb + 14, centers[3], yb + 2, color=INK)
    d.add(String(centers[3] - 8, yb - 8, "6.  broadcast -> confirmed on-chain", fontName="Helvetica-Bold",
                 fontSize=7.2, textAnchor="end", fillColor=INK))
    if refund:
        yr = 44
        arrow(d, centers[3], yr + 4, centers[0], yr + 4, color=AMBER, dashed=True)
        d.add(String((centers[3] + centers[0]) / 2 + 14, yr + 9,
                     "never broadcast?  funder htlcRefund after refundEpoch + 1 (chain-enforced)",
                     fontName="Helvetica-Bold", fontSize=7, textAnchor="middle", fillColor=AMBER))
    return d

def diagram_timeline(width=505, height=172):
    d = Drawing(width, height)
    x0, x1, y = 46, width - 30, 74
    # bands: E0 fund | claim window (through refundEpoch-1) | dead zone refundEpoch | refund opens refundEpoch+1
    seg = [(x0, 110, ACCENT_BG, "funding epoch (x402Pay)", INK),
           (x0 + 110, 158, colors.white, "claim window — BeforeEpoch(refundEpoch)", INK),
           (x0 + 268, 60, colors.HexColor("#fbeeea"), "refundEpoch", AMBER),
           (x0 + 328, x1 - (x0 + 328), colors.HexColor("#e9f4ee"), "refund opens", GREEN)]
    for sx, sw, fill, label, tc in seg:
        d.add(Rect(sx, y, sw, 26, fillColor=fill, strokeColor=LINE, strokeWidth=0.7))
        d.add(String(sx + sw / 2, y + 9, label, fontName="Helvetica-Bold" if fill != colors.white else "Helvetica",
                     fontSize=7.2, textAnchor="middle", fillColor=tc))
    d.add(Line(x0, y - 12, x1, y - 12, strokeColor=MUTED, strokeWidth=0.9))
    ticks = [("E0", x0), ("…", x0 + 110), ("refundEpoch−1", x0 + 268 - 30), ("refundEpoch", x0 + 268 + 30),
             ("refundEpoch+1", x0 + 328 + 38), ("time", x1)]
    for label, tx in ticks:
        d.add(String(tx, y - 24, label, fontName="Helvetica", fontSize=7, textAnchor="middle", fillColor=MUTED))
    d.add(String(x0, y + 44, "HTLC time-lock timeline (live-verified on esmeralda):",
                 fontName="Helvetica-Bold", fontSize=8.6, fillColor=INK))
    d.add(String(x0, y - 44, "Run U failed: wallet dry-ran at epoch 12753 vs predicate AfterEpoch(12754) — the wallet's epoch view lags the",
                 fontName="Helvetica", fontSize=6.8, fillColor=MUTED))
    d.add(String(x0, y - 54, "probe across the boundary; AfterEpoch(N) is STRICT (spendable at N+1). The green band opens one epoch after refundEpoch —",
                 fontName="Helvetica", fontSize=6.8, fillColor=MUTED))
    d.add(String(x0, y - 64, "run V refunded there, at 12759 = 12758 + 1.",
                 fontName="Helvetica", fontSize=6.8, fillColor=MUTED))
    return d

def diagram_architecture(width=505, height=170):
    d = Drawing(width, height)
    boxes = [
        (10, 100, 150, 52, "Sapient fork", "x402Pay · x402SignClaim\nsign-only · popup approvals", ACCENT_BG),
        (185, 100, 130, 52, "Client package", "@potr3288/x402-ootle\nzero-dep TS, drives the flow", colors.white),
        (340, 100, 150, 52, "Facilitator spec", "POST /x402/settle\nhold -> serve -> broadcast", colors.white),
        (100, 22, 300, 46, "Tari Ootle chain (esmeralda live-verified)", "stealth transfers · HTLC condition trees · epochs", colors.HexColor("#eef4f0")),
    ]
    for x, y, w, h, t, s, fill in boxes:
        d.add(Rect(x, y, w, h, fillColor=fill, strokeColor=INK if fill == colors.white else ACCENT, strokeWidth=1.0, rx=4, ry=4))
        d.add(String(x + w / 2, y + h - 15, t, fontName="Helvetica-Bold", fontSize=8.6, textAnchor="middle", fillColor=INK))
        for i, line in enumerate(s.split("\n")):
            d.add(String(x + w / 2, y + h - 27 - i * 9.5, line, fontName="Helvetica", fontSize=7, textAnchor="middle", fillColor=MUTED))
    arrow(d, 160, 126, 185, 126); arrow(d, 315, 126, 340, 126)
    arrow(d, 85, 100, 180, 68); arrow(d, 250, 100, 250, 68); arrow(d, 415, 100, 320, 68)
    return d

# ---------------------------------------------------------------- doc builders

PAGE_W, PAGE_H = A4
MARGIN = 46

def footer(canv, doc, running):
    canv.saveState()
    canv.setFont("Helvetica", 7.5)
    canv.setFillColor(MUTED)
    canv.drawString(MARGIN, 24, running)
    canv.drawRightString(PAGE_W - MARGIN, 24, f"Page {doc.page}")
    canv.setStrokeColor(LINE); canv.setLineWidth(0.6)
    canv.line(MARGIN, 34, PAGE_W - MARGIN, 34)
    canv.restoreState()

def cover(story, kicker, title, subtitle, meta_lines):
    sp = Spacer(1, 150)
    story.append(sp)
    story.append(Paragraph(kicker, S("kicker", fontName="Helvetica-Bold", fontSize=10, textColor=ACCENT, spaceAfter=10)))
    story.append(Paragraph(title, STY["cover_t"]))
    story.append(Spacer(1, 10))
    story.append(Paragraph(subtitle, STY["cover_s"]))
    story.append(Spacer(1, 26))
    story.append(rule())
    story.append(Spacer(1, 12))
    for line in meta_lines:
        story.append(Paragraph(line, S("meta", fontSize=9.5, textColor=MUTED, leading=15)))
    story.append(PageBreak())

def doc_a(out):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), out)
    doc = SimpleDocTemplate(path, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                            topMargin=48, bottomMargin=46,
                            title="x402 over Tari Ootle — How It Works",
                            author="PotR3288")
    story = []
    cover(story, "TECHNICAL BRIEFING",
          "x402 over Tari Ootle",
          "Pay-per-request HTTP payments on Tari's confidential contract layer — how the "
          "x402 protocol, the Sapient wallet, and a new settlement rail fit together, and "
          "what was built and verified.",
          ["PotR3288 · October 31, 2026",
           "Live-verified on Tari esmeralda testnet (happy path + refund, commits e82cf1c…aee37c8)",
           "Companion brief for the Sapient developer: sapient-developer-brief.pdf"])

    story.append(P("1. What x402 is", "h1"))
    story.append(P(
        "x402 is an open protocol for internet-native payments, built on the long-unused HTTP "
        "402 <i>Payment Required</i> status code. When a client requests a protected resource, the "
        "server answers 402 with a machine-readable quote describing what the resource costs and "
        "how to pay. The client's wallet pays, presents proof, and the server releases the "
        "resource. No accounts, no API keys, no subscription plumbing — payment is just part of "
        "HTTP. The original x402 rails settle on EVM chains with stablecoins; the protocol is "
        "chain-agnostic by design, which is what this project exploits."))
    story.append(P(
        "Two roles matter beyond the client and server. A <b>facilitator</b> is infrastructure "
        "that validates and settles payments on the payer's behalf, and a <b>scheme</b> defines "
        "how a particular chain's payment is constructed and verified. Our work defines an Ootle "
        "scheme and makes the Ootle indexer itself the facilitator."))

    story.append(P("2. Tari Ootle and Sapient", "h1"))
    story.append(P(
        "<b>Tari Ootle</b> is Tari's digital-assets layer: a confidential-contract chain where "
        "value lives in <b>stealth outputs</b> — amounts and ownership encrypted — and spending "
        "is gated by <b>condition trees</b>, Merkle-structured scripts whose leaves can require "
        "hash preimages, epoch windows, or possession of specific keys. Two primitives do the "
        "heavy lifting here: a stealth transfer can be locked behind a two-leaf tree "
        "(hash-lock OR time-locked refund), and an epoch is the chain's native clock."))
    story.append(P(
        "<b>Sapient</b> is the Tari Ootle browser wallet (a Chrome extension by chironbuilds, "
        "testnet-stage). It injects <font face='Courier'>window.tari</font> into pages, keeps "
        "keys on-device, renders a human approval popup for every transaction request, and speaks "
        "natively to stealth transfers and HTLC condition trees. It is the only surface with all "
        "three properties the payment rail needs — browser integration, on-device keys, and "
        "native HTLCs — which is why the fork builds on it."))
    story.append(Spacer(1, 6))
    story.append(diagram_architecture())
    story.append(Spacer(1, 10))

    story.append(P("3. What was built", "h1"))
    story.append(P(
        "The fork (branch <font face='Courier'>x402/quote-and-signonly</font>) adds four "
        "coordinated pieces around Sapient's existing primitives:"))
    story.append(dtable(
        ["Piece", "What it does"],
        [["Quote envelope (x402Pay)",
          "A 402 quote becomes a first-class wallet request: the popup shows what the user is "
          "buying, the price, the fee, and the refund deadline in wall-clock time. Approving it "
          "funds an HTLC-locked stealth output (an htlcFund underneath) with a two-leaf condition "
          "tree: hash-lock claim OR time-locked refund."],
         ["Sign-only claim (x402SignClaim)",
          "A new signing mode: build, sign and <b>seal</b> the HTLC claim transaction but do NOT "
          "broadcast it. The sealed payload goes back to the dApp with status signed-unbroadcast, "
          "so history never implies funds moved."],
         ["Facilitator spec (indexer as settlement)",
          "docs/x402-facilitator.md pins the settlement interface: POST /x402/settle validates "
          "the sealed claim natively against the indexer's own chain index, HOLDS it, the "
          "merchant serves, then the indexer broadcasts. Idempotent, structured errors, no "
          "dry-run stage."],
         ["Client package (@potr3288/x402-ootle)",
          "A zero-dependency TypeScript package: wraps fetch to parse the 402, drives the wallet "
          "requests, persists the refund mask, settles, and refunds on expiry."]],
        [120, None]))

    story.append(P("4. The flow, end to end", "h1"))
    story.append(P(
        "The ordering is merchant-initiated hold-then-broadcast — chosen over "
        "broadcast-immediately (merchant owns funds before serving) and client-receipt-triggered "
        "(client gets a free-serve option). The hold window is what makes the HTLC meaningful:"))
    story.append(Spacer(1, 4))
    story.append(diagram_flow())
    story.append(Spacer(1, 6))
    story.append(P(
        "Steps 1–4 happen with nothing on chain but the funding itself. The claim only reaches "
        "the chain after the merchant has confirmed settlement — and if the facilitator never "
        "broadcasts, the funder's refund path stays intact the entire time."))

    story.append(P("5. The refund backstop and honest trust semantics", "h1"))
    story.append(P(
        "The HTLC is not a delivery proof — HTTP delivery cannot be proven to a payment layer. "
        "What it guarantees is client-side abort plus automatic recovery: while the claim is "
        "held, the client's refund path is untouched, and once the refund epoch passes the funds "
        "return to the funder with nobody's cooperation. The indexer's hold power is disclosed "
        "rather than hidden: it can withhold broadcast (a merchant-side trust decision, auditable "
        "on chain), it cannot redirect or spend the funds (the claim is bound to payee, amount "
        "and hashlock, and the indexer holds no re-signing key), and a late broadcast is rejected "
        "on-chain by the claim's own epoch guard."))
    story.append(Spacer(1, 4))
    story.append(diagram_timeline())
    story.append(Spacer(1, 8))

    story.append(P("6. Verified live on esmeralda", "h1"))
    story.append(P(
        "Both scenarios ran against the public esmeralda indexer through the real extension UI "
        "(real popup approvals, deterministic wallets, a frozen facilitator for the refund case):"))
    story.append(dtable(
        ["Scenario", "Result", "On-chain evidence"],
        [["Happy path — pay, sign, hold, serve, broadcast",
          "PASS", "Claim tx 21257dd3cb0e…891a0b2 finalized with Commit; HTLC output confirmed spent."],
         ["Refund — facilitator frozen, claim never broadcast",
          "PASS", "Settlement reports expired; funder's htlcRefund tx 52a51a16ee86…ec9f1 finalized "
                  "with Commit; HTLC output refunded."]],
        [150, 40, None]))
    story.append(Spacer(1, 4))
    story.append(P(
        "Two product-level bugs surfaced and were fixed along the way: the SDK's HTLC "
        "verification was key-order sensitive (fixed by canonicalizing the relayed condition "
        "tree before verification), and the settlement design initially assumed a dry-run "
        "preflight the protocol cannot support (removed; broadcast itself is the admissibility "
        "proof). The refund leg also pinned down the chain's epoch semantics: AfterEpoch(N) is "
        "strict — spendable at N+1."))

    story.append(P("7. Where it goes next", "h1"))
    story.append(P(
        "The rail is scoped for upstream contribution: a scheme spec for the x402 foundation "
        "repo (which requires spec-first approval), an SDK implementation, and an e2e catalog "
        "entry — all drafted. The private-fee claim lane (keeping the merchant's address off the "
        "claim entirely) is the next wallet-side milestone; it needs a small SDK export of the "
        "envelope builder."))
    doc.build(story, onFirstPage=lambda c, d: footer(c, d, "x402 over Tari Ootle — how it works"),
              onLaterPages=lambda c, d: footer(c, d, "x402 over Tari Ootle — how it works"))

def doc_b(out):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), out)
    doc = SimpleDocTemplate(path, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                            topMargin=48, bottomMargin=46,
                            title="Sapient Fork: x402 Changes & Additions",
                            author="PotR3288")
    story = []
    cover(story, "DEVELOPER BRIEFING · FOR THE SAPIENT (CHIRONBUILDS) MAINTAINER",
          "The x402 fork: what changed in Sapient",
          "A change inventory for the chironbuilds/tari-wallet fork branch "
          "x402/quote-and-signonly — new request kinds, the sign-only build path, an SDK "
          "bug found on the way, and live-testnet verification results.",
          ["PotR3288 · October 31, 2026 · base chironbuilds/tari-wallet @ e2f7bf9 (0.6.17)",
           "Branch x402/quote-and-signonly at aee37c8 · 278 ext + 34 pkg + 24 facilitator tests green",
           "Companion explainer for a general audience: x402-over-tari-ootle.pdf"])

    story.append(P("1. The gap this fills", "h1"))
    story.append(P(
        "Sapient in 0.6.17 already had the hard parts: htlcFund, htlcClaim and htlcRefund wired "
        "through the RPC surface, stealth transfers, and scriptPathSpend reported honestly in "
        "tari_getCapabilities. What it did not have was any way to <b>produce a signed "
        "transaction without broadcasting it</b> — every path ended in submit. That single gap "
        "is what blocks settlement flows where a third party (the Ootle indexer, acting as an "
        "x402 facilitator) must hold a signed payload and broadcast it later. The fork adds "
        "that mode plus the payment-terms plumbing around it, with a deliberately small diff "
        "surface: two new request kinds, one new background module, popup rendering, and docs."))

    story.append(P("2. Change inventory", "h1"))
    story.append(dtable(
        ["File / area", "Change", "Notes"],
        [["src/lib/messages.ts",
          "New kinds x402Pay and x402SignClaim; request status gains signed-unbroadcast; "
          "WalletCapabilities.signOnly field doc.",
          "Types mirror the facilitator spec; the status is distinct from approved/submitted so "
          "popup history never implies funds moved."],
         ["src/background/index.ts",
          "Dispatch cases for both kinds; a validation gate before the execution switch; "
          "capabilities report signOnly: isLocal.",
          "Validation: hashLockHex must be 64 lowercase hex (this also closes an audited htlcFund "
          "weakness), refundEpoch bounded, expiresAt in the future, amount > 0, claimantAddress "
          "well-formed — each rejection is its own actionable error."],
         ["src/background/x402SignOnly.ts (new)",
          "Build/sign/seal-without-submit: resolve the funded HTLC output, buildScriptPathWitness "
          "with the preimage + claim leaf + Merkle proof, buildStealthTransferStatement, then "
          "TransactionBuilder -> resolve -> sign -> seal — the htlcClaim pipeline minus submit.",
          "Also canonicalizeRelayedConditions(): rebuilds the relayed condition tree extracting "
          "BOTH leaf keys verbatim from the relayed tree — never substituting the account's own — "
          "so the security property of the relayed terms is preserved (see §4)."],
         ["src/popup/*",
          "Approval rendering for both kinds.",
          "x402SignClaim copy says explicitly: “Sign only — not submitted to the network. The "
          "settlement service submits it later.” Shows what is being bought, price, fee, and "
          "refund deadline in wall-clock time."],
         ["src/background/capabilities.ts",
          "signOnly: isLocal with an honest comment (verified live; does not claim delivery "
          "proof or facilitator honesty).",
          "Flag stayed false-equivalent-honest until Phase 5 e2e passed, then caveats were "
          "updated — same pattern as scriptPathSpend."],
         ["docs/x402-facilitator.md (new)",
          "The settlement interface spec: POST /x402/settle (idempotent on localDigest), "
          "GET /x402/settlement/{digest}, hold->broadcast->confirmed/expired state machine, "
          "nine-cause error contract, validation checklist, confidentiality rule (no preflight "
          "that sees the preimage), and a trust/honesty-semantics section.",
          "Written so ANY ootle-indexer deployment can opt in; enabling settlement is a "
          "deployment decision, not a fork of the indexer."],
         ["docs/integration/x402.md (new)",
          "dApp-facing guide: the 402 quote envelope, the flow, and a field-by-field alignment "
          "table against the x402 foundation repo's v2 specification.",
          "Documents the four deliberate wire deviations from foundation v2 (flat envelope, "
          "scheme fields as extra, no CAIP-2 field, plain-JSON header with no PAYMENT-SIGNATURE "
          "analogue)."],
         ["packages/x402-ootle (new)",
          "@potr3288/x402-ootle: zero-dependency client package (pay402 fetch wrapper, pay(), "
          "settle(), refund on expiry), 34 tests.",
          "Persisted outputMask is load-bearing: the funder cannot recover the refund path "
          "without it."],
         ["e2e/ (new, harness-only)",
          "Playwright harness driving the real extension (real popup approvals, deterministic "
          "seed-derived wallets) + a local facilitator stand-in implementing the spec (24 tests).",
          "Harness-only footprint: no production dependency added beyond the playwright devDep; "
          "src/ and packages/ otherwise frozen."]],
        [118, None, 152], fs=7.9))

    story.append(P("3. What was deliberately NOT changed", "h1"))
    for b in [
        "No changes to the stealth/HTLC core, transaction building, or account model — the fork "
        "reuses htlcFund's execution path for x402Pay rather than duplicating builder logic.",
        "No new runtime dependencies (playwright is a devDependency of the e2e harness only).",
        "No dry-run/preflight anywhere in the settlement path: the SDK's claim path would "
        "otherwise POST the fully-signed transaction — preimage included — to the facilitator "
        "before settle. The preimage is the merchant's proof of payment; the facilitator spec "
        "forbids seeing it early, and the wallet's build path never dry-runs.",
        "Capability flags report honestly and stay tied to account kind (isLocal), matching the "
        "existing scriptPathSpend pattern.",
    ]:
        story.append(P(b, "bullet", True))

    story.append(P("4. SDK findings you'll want upstream", "h1"))
    story.append(P(
        "Four things surfaced during live verification that are relevant to "
        "@chironbuilder/ootle-sdk itself:", "body"))
    story.append(dtable(
        ["Finding", "Detail", "Suggested action"],
        [["verifyHtlcTerms is key-order sensitive",
          "It compares the rebuilt vs relayed HTLC condition tree with a raw JSON.stringify — "
          "byte-identical trees are rejected when key insertion order differs (extension storage "
          "canonicalizes key order; the SDK rebuild does not). Reproduced on 0.1.30.",
          "Compare canonicalized JSON (sort keys recursively) or compare parsed structures. "
          "The fork works around it by rebuilding the relayed tree via htlcConditions before "
          "verification."],
         ["htlcClaim is submit-wired end to end",
          "Every SDK claim path ends in submit; sign-only settlement flows need the pipeline "
          "minus submit. The low-level surface is sufficient today (buildScriptPathWitness + "
          "buildStealthTransferStatement + TransactionBuilder -> resolve -> sign -> seal all "
          "work), but it is non-obvious and undocumented.",
          "Consider an official sign-only/seal-only variant of htlcClaim returning the sealed "
          "payload."],
         ["AfterEpoch(N) is strict",
          "Live-verified: AfterEpoch(12754) rejected while executing at epoch 12753, satisfied "
          "from 12759 = refundEpoch 12758 + 1 (run V). Spendable at N+1, not N.",
          "Worth documenting in the HTLC condition docs; it is easy to misread and cost a "
          "test run."],
         ["sendPrivately outputs are not view-key scannable",
          "A recipient cannot discover the transfer by scanning with the view key; "
          "recipientCommitment must be delivered out of band (the payer's result carries "
          "transactionId, recipientCommitment, recipientSubstateId, minimumValuePromise).",
          "Document the out-of-band requirement; the claim popup path "
          "(popup-claim-private-payment) is the discovery mechanism for a live wallet."]],
        [105, None, 150], fs=7.9))

    story.append(P("5. Verification summary", "h1"))
    story.append(diagram_flow(refund=False, height=300))
    story.append(Spacer(1, 6))
    story.append(dtable(
        ["Check", "Result"],
        [["Unit tests (extension)", "278/278 green, including per-rejection-path validation tests and real-wasm statement round-trips."],
         ["Client package", "34/34 green."],
         ["Facilitator stand-in vs spec", "24/24 green — one test per error code, idempotency, expired terminal state."],
         ["Typecheck / build", "Clean at aee37c8."],
         ["Live esmeralda happy path", "PASS — claim tx 21257dd3cb0e… finalized Commit, HTLC output spent, resource served after hold."],
         ["Live esmeralda refund", "PASS — facilitator frozen (claim held forever, never broadcast); settlement reported expired; "
                                   "funder htlcRefund tx 52a51a16ee86… finalized Commit, HTLC output refunded at epoch 12759."]],
        [150, None], fs=8.3))
    story.append(Spacer(1, 4))
    story.append(P(
        "The refund run is the interesting one for a maintainer: it exercises the exact failure "
        "mode the design exists for — a facilitator that takes the signed claim and never "
        "broadcasts — and shows the chain, not the facilitator, returning the funds.", "small"))

    story.append(P("6. Reviewing the fork", "h1"))
    story.append(P(
        "Branch x402/quote-and-signonly on github.com/potr3288/tari-wallet, base e2f7bf9. "
        "Key commits: b251547/8828a7a (envelope + honest capability), 6f24c8c (e2e harness), "
        "e82cf1c (SDK key-order workaround + facilitator dry-run removal), b2e2321 (refund "
        "harness fixes), 1b96487 (honesty semantics), aee37c8 (dApp doc + foundation "
        "cross-check). The diff to read first: x402SignOnly.ts, then the dispatch/validation "
        "cases in index.ts, then the facilitator spec. Everything upstream-relevant beyond the "
        "wallet itself lives in docs/x402-facilitator.md — the indexer-side implementation is "
        "pinned by that interface, not by this fork."))
    doc.build(story, onFirstPage=lambda c, d: footer(c, d, "Sapient fork — x402 changes & additions"),
              onLaterPages=lambda c, d: footer(c, d, "Sapient fork — x402 changes & additions"))

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    doc_a("x402-over-tari-ootle.pdf")
    doc_b("sapient-developer-brief.pdf")
    print("built:", os.listdir(here))
