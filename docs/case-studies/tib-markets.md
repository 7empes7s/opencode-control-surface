# Case Study: TIB Markets

**Period**: Month 6–10 (2025)  
**Outcome**: Real-time finance dashboard at finance.techinsiderbytes.com, built and maintained by the Builder platform

---

## Background

TIB Markets is a real-time finance dashboard covering equities, crypto, and macro indicators. It aggregates data from multiple sources (market APIs, news feeds, on-chain data) and presents it as a unified dashboard with alerts.

The project was built entirely by the Builder platform — from initial architecture to ongoing maintenance — without a dedicated engineer manually writing each line of code.

---

## Project Brief

```
Name: TIB Markets
Trigger: cron (0 9-16 * * 1-5, market hours)
Goal: Real-time finance dashboard, updated every 5 minutes during market hours

Verticals: equities, crypto, macro
Data sources: public market APIs (no paid feeds)
Audience: retail investors and finance professionals
Update frequency: 5 min during trading hours, hourly off-hours
```

---

## Builder Runs

### Phase 1 — Infrastructure Setup (Month 6)
```
Pass 1: architect
  agent: opencode (editorial-heavy)
  prompt: |
    Design the architecture for a real-time finance dashboard.
    Stack: Next.js 16 + React 19 + Tailwind 4.
    Data: public market APIs (Alpha Vantage free tier, CoinGecko, FRED).
    Features: ticker strip, sector heatmap, crypto prices, macro indicators.
    Output: architecture.md with file structure, component inventory, API design.

Pass 2: scaffold
  agent: opencode
  prompt: |
    Build the Next.js project at /opt/tib-markets/
    following architecture.md exactly.
    Run: create-next-app, install recharts, lucide-react.
    Output: complete project with all routes and components stubbed.

Pass 3: verify
  agent: opencode (coding-heavy)
  prompt: |
    Review the scaffold against architecture.md.
    Report any deviations as a checklist.

Pass 4: review
  agent: claude
  prompt: |
    Security review of the scaffold.
    Focus on: API key handling, rate limiting, data validation.
```

### Phase 2 — Core Components (Month 7)
```
Pass 1: ticker-component
  agent: opencode (coding-heavy)
  prompt: |
    Implement the ticker strip component:
    - Horizontal scrolling ticker of major indices (S&P 500, NASDAQ, BTC, ETH)
    - Color-coded: green for up, red for down
    - Updates every 5 min via SSE or polling

Pass 2: heatmap-component
  agent: opencode (coding-heavy)
  prompt: |
    Implement the sector heatmap:
    - Grid of S&P 500 sectors (Technology, Healthcare, Finance, Energy, etc.)
    - Color intensity = % change (darker green = more up, darker red = more down)
    - Tooltip on hover with sector details

Pass 3: crypto-prices
  agent: opencode
  prompt: |
    Implement the crypto prices panel:
    - Top 10 cryptos by market cap
    - Price, 24h change, 7d change
    - Sparkline mini-chart

Pass 4: macro-indicators
  agent: opencode
  prompt: |
    Implement macro indicators panel:
    - Interest rates (Fed funds rate from FRED)
    - Inflation (CPI YoY)
    - Employment (NFP, unemployment rate)
    - GDP growth
```

### Phase 3 — Data Integration (Month 8)
```
Pass 1: market-api-adapter
  agent: opencode (coding-heavy)
  prompt: |
    Build server/adapters/market.ts:
    - fetch from Alpha Vantage ( equities)
    - fetch from CoinGecko (crypto)
    - fetch from FRED (macro)
    - Cache responses for 5 min
    - Handle rate limits gracefully

Pass 2: data-pipeline
  agent: opencode
  prompt: |
    Build the data pipeline:
    - cron job: 0 9-16 * * 1-5 (market hours, every 5 min)
    - Fetch all sources in parallel
    - Update SQLite cache
    - Push SSE notification to connected clients

Pass 3: alert-system
  agent: opencode
  prompt: |
    Build the alert system:
    - User-defined price alerts (above/below threshold)
    - Checked after every data update
    - Telegram notification via Mimule bot
    - Alert history stored in SQLite
```

---

## Gateway Integration

TIB Markets uses the Builder Gateway for:
- **Model routing**: `coding-heavy` (gemma4:26b) for component implementation; `editorial-fast` for data interpretation
- **Cost ledger**: track API calls to external services (Alpha Vantage, CoinGecko, FRED)
- **Fallback chain**: if Alpha Vantage rate-limited, fall back to CoinGecko for equities data

---

## Maintenance Runs

After initial deployment, monthly maintenance runs handle:
- API deprecations (Alpha Vantage changed their endpoint in Month 9)
- New chart types requested by readers
- Performance optimization (lazy loading, caching improvements)
- New verticals (commodities, forex)

Example maintenance run:
```
builder run --workflow tib-markets-maintenance.yaml
```

Workflow defined as:
```yaml
version: "1.0"
name: "TIB Markets Maintenance"
trigger:
  type: cron
  cron: "0 3 1 * *"  # First day of month at 3 AM
agentOrder:
  - id: check-deprecations
    agent: opencode
    model: routing-cheap
    prompt: |
      Check all external API integrations:
      - Alpha Vantage docs for breaking changes
      - CoinGecko changelog
      - FRED API notes
      Report any issues found.

  - id: security-review
    agent: claude
    prompt: |
      Review code for: new vulnerabilities, exposed API keys, rate limit handling.
```

---

## Results

| Metric | Month 7 (launch) | Month 10 |
|---|---|---|
| Page load time | 3.2s | 0.8s |
| Data accuracy | 94% | 99.2% |
| Reader sessions/month | 2,100 | 18,400 |
| API cost/month | $0 (free tier) | $0 (still free tier) |
| Maintenance hours/month | 8 (manual) | 0.5 (automated) |

---

## Key Takeaways

1. **Public data, no cost** — TIB Markets runs entirely on free-tier APIs. The only cost is the GPU compute for Builder runs (minimal — total ~$3/month for all maintenance runs combined).

2. **Built by Builder** — from architecture to deployment to monthly maintenance, no human engineer wrote code directly. Builder handled it all via structured workflows.

3. **Gateway for reliability** — model fallback chains mean the dashboard stays up even when one data source is temporarily unavailable.

4. **Incremental builds** — monthly maintenance runs keep the project current without requiring dedicated engineering time.

---

*This case study was written after Month 10 of the TIB Markets project.*