# care_eka_scribe_fe

> AI-powered clinical documentation (EkaScribe) plugin for the [CARE](https://github.com/ohcnetwork/care_fe) EMR.

`care_eka_scribe_fe` is a **Care Frontend plugin** that brings AI **Scribe** capabilities to OHCN's EMR. A clinician records a consultation, the audio is transcribed and structured by [Eka Care](https://www.eka.care/), and the extracted values are automatically matched and filled into CARE questionnaire forms — saving manual data entry and letting clinicians focus on the patient.

It runs as a **Vite Module Federation remote** loaded by [`care_fe`](https://github.com/ohcnetwork/care_fe) and adds a floating microphone control that records, transcribes, and auto-fills forms.

---

## ✨ What it does

- 🎙️ **Record consultations** — a floating mic button captures the doctor–patient conversation.
- 📝 **Live transcription** — audio is streamed to Eka Care via the [`@eka-care/ekascribe-ts-sdk`](https://developer.eka.care/api-reference/health-ai/ekascribe/SDKs/TS-sdk) and returned as a transcript.
- 🧠 **Structured extraction** — a dynamic AI template (built from the current form's fields) instructs the model to return structured JSON (vitals, notes, etc.).
- ⚡ **Auto-fill forms** — extracted values are fuzzy-matched to CARE questionnaire fields and written into the form, then highlighted and scrolled into view for clinician review.
- 🔌 **Zero-route plugin** — integrates purely as a `Scribe` extension point on questionnaire/encounter forms; it defines no standalone pages.

---

## 🏗️ How it works (in brief)

```text
care_fe (host)  ──loads remoteEntry.js──▶  manifest.ts  ──extends "Scribe"──▶  ScribeController
                                                                                     │
                                          useScribe + template-builder ◀─────────────┘
                                                     │
                                   @eka-care/ekascribe-ts-sdk ──▶ Eka Care Voice API
```

1. `care_fe` loads this plugin as a federated remote and renders `ScribeController` on questionnaire forms.
2. The user records a consultation; audio is sent to **Eka Care** through the **EkaScribe SDK**.
3. A **dynamic template** built from the current form's fields tells the AI what JSON to return.
4. Extracted values are **fuzzy-matched** to question labels and written into CARE form responses.
5. Filled fields are **highlighted and scrolled into view** for review.

📖 For the full architecture, data shapes, recording lifecycle, and module breakdown, see **[HOW_IT_WORKS.md](./HOW_IT_WORKS.md)**.

---

## 🚀 Getting started

### Prerequisites

- **Node.js ≥ 22.9.0**
- A running **[care_fe](https://github.com/ohcnetwork/care_fe)** instance configured to load this plugin
- An **EkaScribe access token** from [console.dev.eka.care](https://console.dev.eka.care) (DEV) or [console.eka.care](https://console.eka.care) (PROD)

### Setup

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env and set REACT_EKA_ACCESS_TOKEN and REACT_EKA_ENV

# 2. Install dependencies
npm install

# 3. Start the dev server (build:watch + preview on port 10122)
npm start
```

`npm start` runs two processes concurrently:

| Script        | What it does                                            |
| ------------- | ------------------------------------------------------- |
| `build:watch` | Nodemon watches `src/` and runs `vite build` on changes |
| `preview`     | Serves built assets on **port 10122** with CORS enabled |

> ⚠️ Vite bakes `REACT_*` variables in at **build time** — rebuild after editing `.env`.

## 🔗 care_fe registration

Register the plugin in care_fe via admin pannel:

```json
{
  "url": "http://localhost:10122/assets/remoteEntry.js",
  "name": "care_eka_scribe_fe"
}
```

care_fe resolves the package, loads `remoteEntry.js`, and mounts `ScribeController` on forms that expose the `Scribe` extension point.

---

## 📂 Project structure

```text
src/
├── manifest.ts              # Plugin manifest (routes, extends, components)
├── routes.tsx               # Empty routes (reserved for future pages)
├── index.tsx                # Module-federation entry + exports
├── hooks/
│   └── useScribe.ts         # EkaScribe SDK integration
├── components/
│   └── scribe/
│       ├── ScribeController.tsx   # Main UI + form auto-fill
│       ├── RecordingPanel.tsx
│       ├── ResultPanel.tsx
│       └── ScribeButton.tsx
└── lib/
    ├── template-builder.ts  # Dynamic EkaScribe template creation
    ├── types/scribe.ts
    └── request.ts           # Care API HTTP helpers (for future use)
```

---

## 🛠️ Scripts

- `npm start` — Build in watch mode + preview server
- `npm run build` — Production build (`vite build`)
- `npm run preview` — Serve built assets on port 10122
- `npm run lint` — Run ESLint over `src/`
- `npm run lint-fix` — Run ESLint with `--fix`
- `npm run format` — Format `src/` with Prettier
- `npm run sort-locales` — Sort `public/locale/*.json` keys

---

## 🧩 Tech stack

React 19 · TypeScript · Vite · Module Federation · TailwindCSS · Radix UI · TanStack Query · Jotai · `@eka-care/ekascribe-ts-sdk`
