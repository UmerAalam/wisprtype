# WisprType

A Turborepo monorepo containing a TanStack Start application. The repository is set up as a clean starting point for building the WisprType web app.

## Stack

| Layer | Tool |
| --- | --- |
| Monorepo | Turborepo |
| App | TanStack Start with React 19 and TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS 4 |
| Package manager | npm workspaces |
| Shared config | ESLint and TypeScript packages |

## Project structure

```text
wispr-type/
├── apps/
│   └── web/                    # TanStack Start application
│       └── src/
│           ├── components/     # Shared UI pieces for this app
│           └── routes/         # File-based routes
├── packages/
│   ├── eslint-config/          # Shared ESLint configuration
│   └── typescript-config/      # Shared tsconfig files
├── package.json                # Root scripts and workspace definitions
└── turbo.json                  # Turborepo task configuration
```

## Prerequisites

- Node.js 24 or newer
- npm 11 or newer

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts every workspace in development mode |
| `npm run build` | Builds every workspace through Turborepo |
| `npm run lint` | Runs lint tasks where configured |
| `npm run check-types` | Runs type checks where configured |
| `npm run format` | Formats TypeScript, TSX, and Markdown with Prettier |

To work on only the web app:

```bash
npm run dev --workspace=web
npm run build --workspace=web
```

## Routes

The starter app currently includes:

- `/` — home page
- `/about` — about page

Add pages by creating files under `apps/web/src/routes`. TanStack Router generates `routeTree.gen.ts` automatically.

## Build output

Production builds are written to `apps/web/dist`. Turborepo caches build results locally; add remote caching later if you want to share the cache across machines or CI.

## Repository notes

The remote history began with a README-only commit. Local work was merged on top of it so pushes stay fast-forward. No force push was used.
