"""Render the program-search vs chat report page from compare.py's results and the run records.

    python3 -I build_report.py MANIFEST.json OUT.html

MANIFEST names: results (compare.py output), pricing (agent-eval src/cost-ledger/pricing.ts, the rate owner), tokens
(runId -> a chat run's tokens by kind from chat-tokens.mjs), engineTokens (runId -> an engine curve's seat tokens), exact
(label -> exact_check.py output), and narrative (title, description, lead, sections: list of {heading, html}).
"""
import html
import json
import math
import re
import sys

ARM_LABEL = {"chat-glm54": "Chat plays, GLM-5.4", "program-search-glm54": "Program search, GLM-5.4", "chat-glm53": "Chat plays, GLM-5.3 (reference)"}
ARM_COLOR = {"chat-glm54": "var(--c1)", "program-search-glm54": "var(--c2)", "chat-glm53": "var(--c3)"}
BOARD_LABEL = {"circle-packing": "Circle packing, 26 circles (validation)", "first-autocorrelation": "First autocorrelation inequality (record attempt)"}


def rates(pricing_path):
    text = open(pricing_path, encoding="utf-8").read()
    match = re.search(r"'glm-5\.3':\s*\{\s*input:\s*([0-9.]+),\s*output:\s*([0-9.]+)\s*\}", text)
    return float(match.group(1)) / 1000, float(match.group(2)) / 1000  # USD per token


def proxy_usd(row, manifest, per_in, per_out):
    run = row["runId"]
    if run in manifest.get("tokens", {}):
        t = manifest["tokens"][run]
        return t["freshInput"] * per_in + t["output"] * per_out
    if run in manifest.get("engineTokens", {}):
        t = manifest["engineTokens"][run]
        return t["input"] * per_in + (t["output"] + t["reasoning"]) * per_out
    return None


def fmt(value, digits=3):
    if value is None:
        return "n/a"
    if isinstance(value, (int,)) or (isinstance(value, float) and value.is_integer() and abs(value) >= 1000):
        return f"{int(value):,}"
    if abs(value) != 0 and (abs(value) < 1e-3 or abs(value) >= 1e6):
        return f"{value:.{digits}e}"
    return f"{value:.{digits}f}"


def symlog(d, floor):
    return math.copysign(math.log10(1 + abs(d) / floor), d)


def chart(board, rows):
    """A best-so-far step chart of each arm's distance to the bar against cumulative fresh tokens."""
    floor = 1e-14 if board == "circle-packing" else 1e-13
    series = [(row["arm"], [(p["fresh"], p["distance"]) for p in row["curve"]], row["freshTokensTotal"]) for row in rows if row["curve"]]
    if not series:
        return "<p>No graded constructions yet.</p>"
    xmax = max(max([p[0] for p in pts] + [total or 0]) for _, pts, total in series) or 1
    ys = [symlog(d, floor) for _, pts, _ in series for _, d in pts]
    ymax, ymin = max(ys + [0]), min(ys + [0])
    w, h, left, right, top, bottom = 720, 300, 64, 16, 16, 40
    sx = lambda x: left + (w - left - right) * x / xmax
    sy = lambda y: top + (h - top - bottom) * (ymax - y) / ((ymax - ymin) or 1)
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(BOARD_LABEL[board])} curves">']
    # Zero line: the published bar.
    out.append(f'<line x1="{left}" x2="{w - right}" y1="{sy(0):.1f}" y2="{sy(0):.1f}" class="bar"/>')
    out.append(f'<text x="{w - right}" y="{sy(0) - 4:.1f}" text-anchor="end" class="tick">the bar (distance 0)</text>')
    for exp in range(-16, 1):
        for sign in (1, -1):
            d = sign * 10 ** exp
            if abs(d) < floor:
                continue
            y = symlog(d, floor)
            if ymin - 1e-9 <= y <= ymax + 1e-9 and exp % 2 == 0:
                out.append(f'<line x1="{left - 4}" x2="{left}" y1="{sy(y):.1f}" y2="{sy(y):.1f}" class="axis"/>')
                out.append(f'<text x="{left - 6}" y="{sy(y) + 4:.1f}" text-anchor="end" class="tick">{"-" if sign < 0 else ""}1e{exp}</text>')
    for i in range(0, 6):
        x = xmax * i / 5
        out.append(f'<text x="{sx(x):.1f}" y="{h - bottom + 16}" text-anchor="middle" class="tick">{x / 1e6:.1f}M</text>')
    out.append(f'<text x="{(w + left) / 2:.1f}" y="{h - 4}" text-anchor="middle" class="tick">cumulative fresh tokens</text>')
    out.append(f'<line x1="{left}" x2="{left}" y1="{top}" y2="{h - bottom}" class="axis"/><line x1="{left}" x2="{w - right}" y1="{h - bottom}" y2="{h - bottom}" class="axis"/>')
    for arm, pts, total in series:
        # A step: hold the best so far until the next improvement, then drop to it.
        path = [f"M{sx(pts[0][0]):.1f} {sy(symlog(pts[0][1], floor)):.1f}"]
        path += [f"H{sx(x):.1f} V{sy(symlog(d, floor)):.1f}" for x, d in pts[1:]]
        path.append(f"H{sx(max(total or 0, pts[-1][0])):.1f}")
        out.append(f'<path d="{" ".join(path)}" fill="none" stroke="{ARM_COLOR.get(arm, "var(--ink)")}" stroke-width="2"/>')
        for x, d in pts:
            out.append(f'<circle cx="{sx(x):.1f}" cy="{sy(symlog(d, floor)):.1f}" r="3" fill="{ARM_COLOR.get(arm, "var(--ink)")}"><title>{html.escape(ARM_LABEL.get(arm, arm))}: distance {d:.3e} at {x:,} fresh tokens</title></circle>')
    out.append("</svg>")
    legend = "".join(f'<span class="key"><i style="background:{ARM_COLOR.get(arm, "var(--ink)")}"></i>{html.escape(ARM_LABEL.get(arm, arm))}</span>' for arm, _, _ in series)
    note = "Distance to the bar on a signed log scale; below the line beats it." if board == "first-autocorrelation" else "Distance below the record's sum of radii, log scale."
    return f'<figure>{"".join(out)}<figcaption>{legend}<br>{note} Each point is a graded construction that improved its arm\'s best.</figcaption></figure>'


def table(head, body):
    return "<div class=scroll><table><thead><tr>" + "".join(f"<th>{h}</th>" for h in head) + "</tr></thead><tbody>" + \
        "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in body) + "</tbody></table></div>"


def main(manifest_path, out_path):
    manifest = json.load(open(manifest_path))
    results = json.load(open(manifest["results"]))
    per_in, per_out = rates(manifest["pricing"])
    narrative = manifest["narrative"]
    boards = []
    for board in BOARD_LABEL:
        rows = [row for row in results["rows"] if row["board"] == board]
        if not rows:
            continue
        outcome = table(["Arm", "Run", "Progress at matched tokens", "Best value", "Distance to bar", "Fresh tokens at best", "Progress at full budget", "Best at full budget"],
                        [[html.escape(ARM_LABEL.get(r["arm"], r["arm"])), f'<code>{html.escape(r["runId"])}</code>', fmt(r["progress"], 4),
                          fmt(r["bestValue"], 16) if r["bestValue"] is not None else "n/a", fmt(r["bestDistance"]),
                          fmt(r["bestAtFullBudget"] and r["bestAtFullBudget"]["freshAtBest"]), fmt(r["progressAtFullBudget"], 4),
                          fmt(r["bestAtFullBudget"] and r["bestAtFullBudget"]["value"], 16)] for r in rows])
        cost = table(["Arm", "Matched fresh tokens", "Fresh tokens", "Cached tokens", "Proxy USD at GLM-5.3 rate", "Billed USD"],
                     [[html.escape(ARM_LABEL.get(r["arm"], r["arm"])), fmt(r["matchedFreshTokens"]), fmt(r["freshTokensTotal"]), fmt(r["cachedTokensTotal"]),
                       fmt(proxy_usd(r, manifest, per_in, per_out), 2), "0"] for r in rows])
        load = table(["Arm", "Wall-clock window (UTC)", "Hours", "Samples", "Samples / hour", "Model turns / hour", "Fresh tokens / sample", "Refused", "Refusal share"],
                     [[html.escape(ARM_LABEL.get(r["arm"], r["arm"])), " to ".join((at or "n/a")[:19].replace("T", " ") for at in r["wallClockWindow"]), fmt(r["wallHours"], 2), fmt(r["samples"], 0),
                       fmt(r["samplesPerHour"], 1), fmt(r["modelTurnsPerHour"], 1), fmt(r["freshTokensPerSample"], 0), fmt(r["refusals"], 0), fmt(r["refusalShare"], 3)] for r in rows])
        boards.append(f'<section><h2>{html.escape(BOARD_LABEL[board])}</h2>{narrative.get("boards", {}).get(board, "")}'
                      f'{chart(board, rows)}<h3>Outcome</h3>{outcome}<h3>Tokens and cost</h3>{cost}<h3>Throughput and seat contention</h3>{load}</section>')
    estimand = results["estimands"]["searchMinusChat"]
    exact = table(["Construction", "Reading", "Exactly feasible", "Exact value", "Bound", "Beats bound", "Margin"],
                  [[html.escape(label), reading, "yes" if r["valid"] else f'no ({r["violationCount"]} violations)', f'<code>{r.get("certifiedValue", r["value"])}</code>', f'<code>{out["bound"]}</code>',
                    "yes" if r["beatsBound"] else "no", f'<code>{r["margin"]}</code>'] for label, path in manifest["exact"].items()
                   for out in [json.load(open(path))] for reading, r in out["readings"].items()])
    page = f"""<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>{html.escape(narrative["title"])}</title><meta name=description content="{html.escape(narrative["description"])}">
<style>
:root{{--bg:#fbfaf7;--ink:#1d1c1a;--muted:#6b6862;--line:#dedad2;--panel:#f2efe8;--c1:#2f6db5;--c2:#c2571a;--c3:#7a8a3a;--accent:#2f6db5}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{--bg:#161513;--ink:#ecebe7;--muted:#a19d95;--line:#34322e;--panel:#1f1e1b;--c1:#7fb0ec;--c2:#f0925a;--c3:#b8c86e;--accent:#7fb0ec}}}}
:root[data-theme=dark]{{--bg:#161513;--ink:#ecebe7;--muted:#a19d95;--line:#34322e;--panel:#1f1e1b;--c1:#7fb0ec;--c2:#f0925a;--c3:#b8c86e;--accent:#7fb0ec}}
body{{background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0}}
main{{max-width:980px;margin:0 auto;padding:32px 16px 64px}}
h1{{font-size:26px;margin:0 0 6px}} h2{{font-size:19px;margin:40px 0 8px;border-top:1px solid var(--line);padding-top:24px}} h3{{font-size:15px;margin:20px 0 6px;color:var(--muted)}}
.lead{{background:var(--panel);border-left:3px solid var(--accent);padding:12px 16px;margin:16px 0}}
.scroll{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}}
th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}} th{{color:var(--muted);font-weight:600}}
code{{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}}
figure{{margin:12px 0}} svg{{width:100%;height:auto;background:var(--panel);border-radius:6px}}
svg .axis{{stroke:var(--muted);stroke-width:1}} svg .bar{{stroke:var(--muted);stroke-dasharray:4 4}} svg .tick{{fill:var(--muted);font-size:11px}}
figcaption{{color:var(--muted);font-size:13px}} .key{{margin-right:16px;white-space:nowrap}} .key i{{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}}
.muted{{color:var(--muted)}} ul{{padding-left:20px}}
</style></head><body><main>
<h1>{html.escape(narrative["title"])}</h1><p class=muted>{html.escape(narrative["byline"])}</p>
<div class=lead>{narrative["lead"]}</div>
<p>Registered estimand <code>searchMinusChat</code> (program search minus chat, progress at matched fresh tokens, mean over {estimand["pairs"]} board pairs):
<strong>{fmt(estimand["value"], 4)}</strong>; per board {", ".join(fmt(d, 4) for d in estimand["differences"]) or "n/a"}.
Proxy USD uses the GLM-5.3 rate in agent-eval <code>src/cost-ledger/pricing.ts</code> read when this page was built (fresh input and output, reasoning included; cache reads and writes are unpriced there). Every arm ran on a flat-rate subscription seat: billed USD 0.</p>
{"".join(boards)}
<section><h2>Exact-arithmetic checks</h2>{narrative.get("exactIntro", "")}{exact}</section>
{"".join(f'<section><h2>{html.escape(s["heading"])}</h2>{s["html"]}</section>' for s in narrative["sections"])}
</main></body></html>"""
    open(out_path, "w", encoding="utf-8").write(page)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
