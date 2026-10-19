# Alpha-Gal Rx drug data

This repository builds the drug-ingredient index used by the Alpha-Gal Rx app, from free public U.S. government data:

- **DailyMed** (National Library of Medicine): FDA drug labels, including inactive ingredients
- **RxNorm** (National Library of Medicine): drug names, strengths, brand versions and NDC product codes

A scheduled job refreshes it monthly and publishes it at `https://alphagalreader.github.io/alphagalrx-data/v1/`:

| File | Contents |
|---|---|
| `catalog.json` | Drugs and their strengths, for search |
| `shards/<rxcui>.json` | One drug strength: its products grouped into distinct formulations, with ingredients and the companies that sell them |

The data lists label contents only. It contains no medical judgments and is **not medical advice**. Ingredient sources are usually not stated on labels.

## Running the pipeline

```bash
npm ci
npm run labels      # first run: parse DailyMed bulk releases (~2.5 hours)
npm run rxnorm      # RxNorm codes and brands (~45 minutes)
npm run build       # build pipeline-data/dist
npm run check       # sanity checks
```
