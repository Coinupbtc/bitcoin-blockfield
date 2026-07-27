# Blockfield

Self-contained, responsive **Bitcoin mempool visualization**. Uses the public mempool.space API in the browser (or your own mempool.space-compatible node). Offline → clearly labelled local fallback.

## At a glance

| | |
|---|---|
| **What it is** | A self-contained **Bitcoin mempool visualizer** (projected block war, fee bands, inscription radar) driven by mempool.space-compatible APIs. |
| **What it’s for** | See what’s fighting into the next blocks and how fees route — at a glance — against public or self-hosted mempool data. |
| **How to use it** | `./setup.sh` → **http://127.0.0.1:8080/**, or open `index.html`. Point at your node via the badge / `?node=` URL. |

## Try it (pick one)

### One command
```bash
git clone https://github.com/Coinupbtc/bitcoin-blockfield.git
cd bitcoin-blockfield && ./setup.sh
# open http://127.0.0.1:8080/
```

### Copy-paste
```bash
git clone https://github.com/Coinupbtc/bitcoin-blockfield.git && cd bitcoin-blockfield
python3 -m http.server 8080 --bind 127.0.0.1
```

### One click (no install)
Open [`index.html`](index.html) directly in a browser (double-click / File → Open). Some browsers restrict local `fetch`; if the API fails, use `./setup.sh` instead.

## Point it at your own node

- Click the **data-source badge** in the top bar and paste your node URL, or
- add `?node=https://mempool.example` (or `?api=`) to the URL, or
- it remembers the last node via `localStorage`.

The `/api` suffix is added automatically. If your node stops responding it falls back to public mempool.space and flags **NODE UNREACHABLE**.

## What's on the field (v7)

Single-screen console — everything fits one viewport on desktop (stacks on mobile).

**Projected Block War** (centre). The next three mempool block templates are full-size moving contenders. Capacity, tx count, median fee, colour, and fee gate are live data; 3D movement and the combat feed are the arcade layer. Transactions steer toward Block 1/2/3 by real projected fee bands.

**Inscription Radar.** Paste a mempool.space tx URL or txid. Ordinals envelopes are decoded from witness data (safe image MIME allowlist only; HTML/SVG not executed).

**Rails:** network height / mempool / hashrate / difficulty / halving; fee routes with fiat cost; next-block template; live arrivals. BTC price in the top bar.

Block-found flash, sound toggle, pause, responsive sizing, and `prefers-reduced-motion` are retained.

## License

MIT
