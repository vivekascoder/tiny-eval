import type { CliOptions, EvalOutput } from "./types.ts";
import { escapeHtml } from "./utils.ts";

export function renderReport(output: EvalOutput, options: CliOptions): string {
  const rankings = rankModels(output);
  const rankingRows = rankings
    .map(
      (ranking, index) => `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(ranking.model)}</td>
        <td><span class="rating">${ranking.average.toFixed(1)}</span></td>
        <td>${ranking.count}</td>
      </tr>`,
    )
    .join("");

  const rows = output.evalResults
    .slice()
    .sort((left, right) => right.rating - left.rating || left.evalLLM.localeCompare(right.evalLLM))
    .map(
      (result) => `<tr>
        <td>${escapeHtml(result.repo)}#${result.prNumber}</td>
        <td><span class="rating">${result.rating.toFixed(1)}</span></td>
        <td>${escapeHtml(result.evalLLM)}</td>
        <td>${escapeHtml(result.judgeNotes)}</td>
      </tr>`,
    )
    .join("");

  const cards = output.evaDataset
    .map(
      (item) => `<section class="card">
        <div class="meta">PR #${item.prNumber} · ${escapeHtml(item.commitBeforePR.slice(0, 12))}</div>
        <h2>${escapeHtml(item.githubRepo)}</h2>
        <p>${escapeHtml(item.prDocs)}</p>
      </section>`,
    )
    .join("");

  const topModel = rankings[0];

  return renderHtml({ cards, options, rankingRows, rows, topModel });
}

function renderHtml({
  cards,
  options,
  rankingRows,
  rows,
  topModel,
}: {
  cards: string;
  options: CliOptions;
  rankingRows: string;
  rows: string;
  topModel: ModelRanking | undefined;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>tiny-eval report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Iosevka+Charon:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --background-primary: #202020;
      --background-secondary: #161616;
      --background-modifier-border: #363636;
      --text-normal: #dcddde;
      --text-muted: #999999;
      --text-accent: #8a5cf5;
      --interactive-accent: #7f6df2;
      --green: #70c27e;
      --red: #ff6b6b;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background-primary);
      color: var(--text-normal);
      font-family: "Iosevka Charon", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0;
    }

    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }

    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: end;
      border-bottom: 1px solid var(--background-modifier-border);
      padding-bottom: 20px;
      margin-bottom: 24px;
    }

    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; font-weight: 600; }
    h2 { font-size: 16px; margin: 6px 0 10px; }
    p { color: var(--text-muted); white-space: pre-wrap; line-height: 1.45; }
    .meta { color: var(--text-muted); font-size: 13px; }
    .score {
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      padding: 12px 14px;
      background: var(--background-secondary);
      min-width: 132px;
      text-align: right;
    }
    .score strong { color: var(--green); font-size: 24px; display: block; }
    .score .model { color: var(--text-normal); display: block; max-width: 280px; overflow-wrap: anywhere; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--background-secondary);
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }

    th, td {
      border-bottom: 1px solid var(--background-modifier-border);
      padding: 12px;
      text-align: left;
      vertical-align: top;
      line-height: 1.4;
    }

    th { color: var(--text-muted); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .rating { color: var(--green); font-weight: 600; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }

    .card {
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      background: var(--background-secondary);
      padding: 14px;
      min-width: 0;
    }

    @media (max-width: 700px) {
      header { grid-template-columns: 1fr; }
      .score { text-align: left; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="meta">tiny-eval · ${escapeHtml(new Date().toISOString())}</div>
        <h1>${escapeHtml(options.repo)}</h1>
        <div class="meta">eval ${escapeHtml(options.evalLLMs.join(", "))} · judge ${escapeHtml(options.evalJudgeLLM)}</div>
      </div>
      <div class="score">
        <span class="meta">leader</span>
        <strong>${topModel ? topModel.average.toFixed(1) : "0.0"}</strong>
        <span class="model">${escapeHtml(topModel?.model ?? "none")}</span>
      </div>
    </header>

    <table>
      <thead>
        <tr>
          <th>rank</th>
          <th>model</th>
          <th>average</th>
          <th>cases</th>
        </tr>
      </thead>
      <tbody>${rankingRows}</tbody>
    </table>

    <table>
      <thead>
        <tr>
          <th>case</th>
          <th>rating</th>
          <th>model</th>
          <th>judge notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="grid">${cards}</div>
  </main>
</body>
</html>`;
}

type ModelRanking = {
  model: string;
  average: number;
  count: number;
};

function rankModels(output: EvalOutput): ModelRanking[] {
  const byModel = new Map<string, { total: number; count: number }>();

  for (const result of output.evalResults) {
    const current = byModel.get(result.evalLLM) ?? { total: 0, count: 0 };
    current.total += result.rating;
    current.count += 1;
    byModel.set(result.evalLLM, current);
  }

  return Array.from(byModel, ([model, stats]) => ({
    model,
    average: stats.total / Math.max(stats.count, 1),
    count: stats.count,
  })).sort((left, right) => right.average - left.average || left.model.localeCompare(right.model));
}
