# Cramsesh Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relaunch the LearnHarness fork as Cramsesh: new logo and icons, a fully warm yellow/blue theme in Nunito, every user-visible name changed, an About page and README that credit LearnHarness, and a Windows/Linux desktop release pipeline pointed at the owner's repo.

**Architecture:** Surface rebrand only. Theme lives in `app/globals.css` tokens; the logo is one master SVG that feeds the in-app mark, the browser icon, the desktop icons and the README banners; packaging identity lives in `package.json`, `electron-builder.yml`, `electron/main.cjs`, the release workflow and `scripts/verify-release.ts`. Hidden technical identifiers (`LH_*`, `x-learnharness-*`, MCP bridge name, storage keys, scheduled tasks, data repo) are deliberately untouched.

**Tech Stack:** Next.js 16 (App Router, `next/font/google`, file-based `app/icon.svg`), Tailwind v4 CSS-first tokens, Electron + electron-builder, GitHub Actions, `@resvg/resvg-js` for rasterising, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-11-16-cramsesh-rebrand-design.md` (read it; it is the authority). Recon with exact file:line references: `C:\Users\kevin\AppData\Local\Temp\claude\dfc9cf6c5b3241fc\a35a7422-5657-4555-9f6d-416a475797ce\scratchpad\rebrand-plan-recon.md`.

## Global Constraints

- Product name in prose and titles: `Cramsesh`. Wordmark: lowercase `cram` + `sesh`, "sesh" in bright blue (light) / sunflower (dark).
- Tagline, verbatim: `AP prep made EZ`.
- Palette, verbatim: cream `#FBF6EA`, sunflower `#F2B33D`, ink blue `#1F3A5F`, bright blue `#3D6FB6`.
- Font: Nunito (via `next/font/google`) for UI, prose and titles. Code/`font-mono` uses a monospace stack; KaTeX keeps its own fonts.
- Version `1.0.0`. Package name `cramsesh`. `productName` `Cramsesh`. `appId` `com.cramsesh.Cramsesh`. `desktopName` `cramsesh.desktop`. Homepage `https://github.com/Kevin09sun/cramsesh`. Publish owner `Kevin09sun`, repo `cramsesh`.
- `author`: `{ "name": "Hongyi Sun", "email": "37144566+Kevin09sun@users.noreply.github.com" }`. `contributors`: `[{ "name": "Amos Blomqvist", "url": "https://github.com/amosblomqvist" }]`. Never the owner's personal email anywhere.
- Credit line, verbatim: `Built on LearnHarness by Amos Blomqvist` linking `https://github.com/amosblomqvist/learnharness`. License `AGPL-3.0-only`; `LICENSE` file unchanged.
- **Keep unchanged:** `LH_*` env vars; `x-learnharness-*` headers; `application/x-learnharness-source`; MCP bridge name `learnharness` / `mcp__learnharness__*`; ChatGPT namespace `learnharness`; `x-opencode-client: "learnharness"`; `__learnharness_custom_provider_binding`; `skills/learnharness/`; `lh:`/`lh-`/`lh.` storage keys; `Symbol.for("lh.*")`; `window.lh`; `LearnHarnessFileDialog` class name; scheduled tasks `LearnHarness` / `LearnHarness Data Sync`; `%LOCALAPPDATA%\LearnHarnessAutostart`; data repo `learnharness-data`. Historical `docs/superpowers/**` files are not edited.
- Contrast: normal text ≥ 4.5:1, large text and UI parts ≥ 3:1, both modes.
- No mac release in 1.0.0: mac matrix entry disabled (commented with a one-line reason), not deleted.
- No private data: screenshots/fixtures come from a temporary `LH_DATA_DIR`, never `data/`.
- Next.js 16: read the relevant guide in `node_modules/next/dist/docs/` before touching metadata, icon files or fonts.
- Tests on Windows: from Git Bash, `NODE_ENV=test ./node_modules/.bin/tsx --test <files>`; full suite `NODE_ENV=test ./node_modules/.bin/tsx --test --test-concurrency=3 tests/*.test.ts tests/*.test.tsx`. The full suite has known Windows baseline failures; judge by comparing the failing-test *names* against the baseline taken before Task 1 (spec reporter `✖` lines), not by a green run. Also `npm run typecheck` and `npm run lint` must pass.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. A returning user's saved appearance settings (`sessionNameSerif: true`, a custom `background`, a custom reading font) must load without errors and without the removed serif switch reappearing — Task 1 test.
2. A desktop user who has both a `LearnHarness` and a `Cramsesh` profile folder, or only the old one, or neither, or runs dev mode, gets the right folder and never a fresh empty profile when the old one exists — Task 4 test.
3. Brand colours used as text or controls on each mode's background stay readable (contrast floor) — Task 1 test.
4. A user-visible "LearnHarness" string surviving anywhere in UI/server copy (outside the credit and the kept identifiers) — Task 3 guard test.
5. A Windows machine running `setup.ps1` after the repo rename (`origin` ending `/cramsesh` or `/cramsesh.git`, or still `/learnharness`) clones `learnharness-data.git` — Task 4 test.

---

### Task 0 (controller): baseline

- [ ] Create the worktree/branch `feat/cramsesh-rebrand` off `custom`; move the untracked spec and this plan onto it and commit them.
- [ ] Run the full suite once; save the failing-test names to the ledger as the baseline.

### Task 1: Warm theme, Nunito, serif switch removed

**Files:**
- Modify: `app/globals.css` (`:root`, `.dark`, `.light` tokens; `@theme inline` fonts; remove `lh-cmu` `@font-face` and the non-inline `--font-title` block → title uses Nunito), `app/layout.tsx` (fonts), `components/settings/appearance.tsx` (drop `sessionNameSerif` → `--font-title` mapping; `--font-prose` fallback uses the Nunito variable), `components/settings/appearance-section.tsx` (remove the "Session names in serif" row; `DEFAULT_READING_FONT = "Nunito"`; remove `"CMU Serif"` from `CURATED_FALLBACK_FONTS`; Background hint/placeholder show the current mode's default background instead of `#141414`), `src/core/settings.ts` (keep `sessionNameSerif` readable but unused so old records parse; comment it as retired), `electron/main.cjs:312,330` (window chrome colours: `#14213A` background, symbol `#EDE6D6`), `components/lh-mark.tsx`'s `--lh-mark-ring` rule in globals.css only if Task 2 no longer needs it (Task 2 owns the mark).
- Delete: `public/fonts/cmunbx.ttf`, `public/fonts/OFL.txt` (only if no other reference remains; grep first).
- Test: `tests/brand-theme.test.ts` (new); update `tests/light-mode.test.tsx`, `tests/font-menu.test.tsx`, `tests/render-md-blocks.test.tsx` where they assert old token values/fonts; any appearance test asserting the serif row.

**Interfaces:**
- Produces: CSS variables `--background --foreground --card --popover --primary --primary-foreground --secondary --muted --muted-foreground --accent --border --input --ring` with the values below; `--font-nunito` (next/font variable) feeding `--font-ui`, `--font-prose`, `--font-sans`, `--font-title`. Later tasks use the Tailwind utilities (`bg-card`, `text-primary`, `font-title`…) only.

Token starting values (adjust only to meet the contrast test; keep the hue):

| token | light (`.light`) | dark (`:root` and `.dark`, identical) |
|---|---|---|
| background | `#FBF6EA` | `#14213A` |
| foreground | `#1F3A5F` | `#EDE6D6` |
| card / secondary / muted | `#F4ECD8` | `#1A2A47` |
| popover | `#FFFCF4` | `#182640` |
| primary / primary-foreground | `#3D6FB6` / `#FBF6EA` | `#F2B33D` / `#1F3A5F` |
| accent / accent-foreground | `#F7E3B0` / `#1F3A5F` | `#2B3F63` / `#EDE6D6` |
| muted-foreground | derived ink, ≥4.5:1 on card | derived cream, ≥4.5:1 on card |
| border / input | `#E3D6B8` | `#2B3F63` |
| ring | `#3D6FB6` | `#F2B33D` |

- [ ] **Step 1: Write failing tests** in `tests/brand-theme.test.ts`:
  - `light and dark tokens use the Cramsesh palette`: parse `app/globals.css` text; assert `.light --background` is `#fbf6ea` and `--primary` `#3d6fb6`; `:root` and `.dark` `--background` `#14213a`, `--primary` `#f2b33d`; `:root` and `.dark` blocks declare identical token values.
  - `token pairs meet contrast`: compute WCAG relative-luminance contrast for each mode: foreground/background ≥ 4.5, foreground/card ≥ 4.5, muted-foreground/background ≥ 4.5, muted-foreground/card ≥ 4.5, primary-foreground/primary ≥ 4.5, accent-foreground/accent ≥ 4.5, ring/background ≥ 3, border/background — no assertion (decorative).
  - `fonts are Nunito`: `app/layout.tsx` imports `Nunito` from `next/font/google` and not `JetBrains_Mono`/`Source_Sans_3`; globals.css contains no `lh-cmu`.
  - `old appearance records still apply`: `appearanceVars({ ...defaults, sessionNameSerif: true, background: "#222222", fontFamily: "Georgia" })` (use the real exported function in `components/settings/appearance.tsx`) returns no `--font-title` key, sets the background var to `#222222`, and `--font-prose` starting `"Georgia"`.
  - `serif switch is gone`: rendering the Appearance section (reuse the existing render helper used by appearance tests) has no element with testid `row-session-serif`.
- [ ] **Step 2: Run** `NODE_ENV=test ./node_modules/.bin/tsx --test tests/brand-theme.test.ts` → FAIL.
- [ ] **Step 3: Implement** the file changes listed above.
- [ ] **Step 4: Run** the new test plus `tests/light-mode.test.tsx tests/font-menu.test.tsx tests/render-md-blocks.test.tsx` and every `tests/*appearance*` file → PASS (update their old-value assertions to the new tokens, never weaken what they check).
- [ ] **Step 5:** `npm run typecheck && npm run lint` → clean. Commit `feat(brand): warm Cramsesh theme and Nunito`.

### Task 2: Logo and icons

**Files:**
- Create: `build/brand/cramsesh-mark.svg` (master, 1024×1024 viewBox of the spec geometry scaled ×10.24, transparent outside the rounded square), `components/cramsesh-mark.tsx` (`export function CramseshMark({ className }: { className?: string })`, inline SVG of the master, `aria-hidden`), `app/icon.svg` (copy of the master; Next serves it as the tab icon), `scripts/make-icns.mjs` (writes `build/icon.icns` from the master with PNG entries `ic07`(128) `ic08`(256) `ic09`(512) `ic10`(1024) `ic11`(32) `ic12`(64) `ic13`(256) `ic14`(512) via resvg).
- Modify: `build/icon-flat.svg` (= master), regenerate `build/icon.ico` + `build/icon.png` with `node scripts/make-icons.mjs`; `build/icon.icon/icon.json` + `Assets/` (single layer: the master's mug+steam+tick as one SVG over a `#3D6FB6` solid fill; remove the three `lh_*` layer files); `build/background.png` / `background@2x.png` re-tinted to cream `#FBF6EA` if they show grey; `components/sidebar.tsx` (use `CramseshMark`, aria-label stays "Home"); `app/globals.css` (drop `--lh-mark-ring`).
- Delete: `components/lh-mark.tsx` (after grep shows no other importer).
- Test: `tests/brand-assets.test.ts` (new).

**Interfaces:**
- Produces: `CramseshMark` (used by Task 5's About page); master path `build/brand/cramsesh-mark.svg` (used by Task 5's banners).

- [ ] **Step 1: Failing tests** `tests/brand-assets.test.ts`:
  - `master mark uses the palette`: the master SVG contains fills/strokes `#3D6FB6`, `#F2B33D`, `#FBF6EA` and no `#949494`/`rgb(148,148,148)`.
  - `icons are regenerated from the master`: `build/icon.png` is 512×512 (read IHDR); `build/icon.ico` lists sizes 16,24,32,48,64,128,256; `build/icon.icns` starts with `icns` and contains `ic10`; rendering the master at 512 with resvg and comparing to `build/icon.png` gives byte-identical PNG pixels (decode both via resvg's `render().pixels` vs. the PNG's — or compare the PNG produced by `make-icons` logic directly).
  - `app icon exists`: `app/icon.svg` equals the master.
  - `sidebar shows the Cramsesh mark`: render the sidebar header (existing sidebar render helper) and find the Home link containing an svg with the bright-blue fill.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS; also existing sidebar tests.
- [ ] **Step 5:** typecheck, lint, commit `feat(brand): Cramsesh mug logo and icons`.

### Task 3: User-visible name and metadata

**Files:**
- Modify: `app/layout.tsx` metadata → `title: "Cramsesh"`, `description: "AP prep made EZ — a study buddy that teaches, quizzes, and checks your thinking."`; replace "LearnHarness" with "Cramsesh" in: `components/update-banner.tsx:28`, `components/settings/chatgpt-connection.tsx:10,11,266`, `components/settings/subscription-connections.tsx:12-14`, `components/settings/model-menu.tsx:88`, `components/settings/claude-code-status.tsx:112`, `src/server/claude-code.ts:26`, `src/server/web-subscription-http.ts:27,62`, `src/server/native-path-picker.ts:188-189` (caption text only; class name stays), `src/server/ap-papers.ts:32` → `"Cramsesh/1.0"`, `src/agent/models.ts:29` → `` `cramsesh/${packageMetadata.version}` ``; `electron-builder.yml` mac `NSMicrophoneUsageDescription` text.
- Test: `tests/brand-copy.test.ts` (new); update `tests/web-subscription-client.test.tsx:73,77-78`, `tests/native-path-picker.test.ts:118,122`, `tests/session-identity.test.ts:42,101`.

- [ ] **Step 1: Failing test** `tests/brand-copy.test.ts` — `no user-visible LearnHarness`: walk `app/`, `components/`, `src/`, `electron/` (`.ts .tsx .cjs .mjs`), strip comments, and collect string/template literals containing `/learn ?harness/i`; allowed only if the literal is one of the kept identifiers (match against an explicit allowlist: `x-learnharness-` prefixes, `application/x-learnharness-source`, `learnharness` exact (MCP/namespace/opencode client), `__learnharness_custom_provider_binding`, `LearnHarnessFileDialog`, `LearnHarness` exact only inside `electron/` profile-fallback code from Task 4) or contains the credit URL `github.com/amosblomqvist/learnharness`. Assert the leftover list is empty. Also assert `metadata.title === "Cramsesh"`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, plus the updated tests listed above.
- [ ] **Step 5:** typecheck, lint, commit `feat(brand): Cramsesh name in app copy`.

### Task 4: Packaging, profile folder, release pipeline, Windows setup

**Files:**
- Create: `electron/profile-dir.cjs` exporting `resolveUserDataDir(appDataDir: string, exists: (p: string) => boolean, dev: boolean): string`.
- Modify:
  - `package.json`: `name`, `version`, `description` (`"Cramsesh — AP prep made EZ. A study buddy that teaches, quizzes, and checks your thinking."`), `author`, `contributors`, `homepage`, `desktopName` (Global Constraints values); `desktop:dist` drops `APPLE_KEYCHAIN_PROFILE=LH_NOTARY APPLE_TEAM_ID=JS6XN22HY6` and `DEVELOPER_DIR` and builds unsigned (`-c.mac.notarize=false -c.mac.identity=null`), kept for local mac builds; `package-lock.json` name/version via `npm install --package-lock-only`.
  - `electron-builder.yml`: `appId`, `productName`, `publish` owner/repo; header comment.
  - `electron/main.cjs`: `PRODUCT_NAME = "Cramsesh"`; after `app.setName`, `app.setPath("userData", resolveUserDataDir(app.getPath("appData"), fs.existsSync, Boolean(process.env.LH_DEV_URL)))`, replacing the existing `-dev` suffix line; must run before `requestSingleInstanceLock`.
  - `.github/workflows/release.yml`: comment out the `macos-26` matrix entry with `# mac disabled for 1.0.0: no Apple signing account yet` (and guard mac-only steps with `if: matrix.platform == 'mac-arm64'` as today so re-enabling is one line); replace the nine `LearnHarness`/`learnharness` paths with `Cramsesh`/`cramsesh`; verify step downloads only `latest.yml` and `latest-linux.yml`.
  - `scripts/verify-release.ts`: `PRODUCT_NAME = "Cramsesh"`, `const MAC_RELEASE = false` gating mac assets, mac feed and mac shape checks; drift guard expects `pkg.name === "cramsesh"`.
  - Delete `.github/workflows/notify-website.yml`.
  - `scripts/windows/setup.ps1:18`: regex `'/(learnharness|cramsesh)(\.git)?$'` → `'/learnharness-data.git'`.
- Test: `tests/profile-dir.test.ts` (new), `tests/windows-setup.test.ts` (new); update `tests/verify-release.test.ts`, `tests/desktop-platform.test.ts:159-168`, `tests/render-update-settings.test.tsx` if it pins the homepage.

**Interfaces:**
- Produces: `package.json` `homepage`/`version` (Task 5's About page reads `LH_HOMEPAGE`/`LH_VERSION`).

- [ ] **Step 1: Failing tests:**
  - `tests/profile-dir.test.ts` with `appData = "/AD"`: only `/AD/LearnHarness` exists → `/AD/LearnHarness`; only `/AD/Cramsesh` → `/AD/Cramsesh`; both → `/AD/Cramsesh`; neither → `/AD/Cramsesh`; dev with only `/AD/LearnHarness-dev` → `/AD/LearnHarness-dev`; dev with neither → `/AD/Cramsesh-dev`. Use `path.join` so it passes on Windows.
  - `tests/windows-setup.test.ts`: read `setup.ps1`, extract the `-replace` pattern and replacement, apply with JS `RegExp` to `https://github.com/Kevin09sun/cramsesh.git`, `…/cramsesh`, `…/learnharness.git`, `…/learnharness` → all `https://github.com/Kevin09sun/learnharness-data.git`.
  - `tests/verify-release.test.ts`: expected asset set for `1.0.0` is exactly `Cramsesh-1.0.0-x64-setup.exe`, its `.blockmap`, `latest.yml`, `Cramsesh-1.0.0-x86_64.AppImage`, `Cramsesh-1.0.0-amd64.deb`, `latest-linux.yml`; drift guard passes on the real files and fails on `productName = "learnharness"` / package name mutation; the workflow's active matrix has no `mac-arm64` entry.
  - `tests/desktop-platform.test.ts`: author/homepage/desktopName/contributors equal the Global Constraints values; publish owner `Kevin09sun`, repo `cramsesh`; no tracked file contains the owner's personal email address (needle built by concatenation in the test).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS plus `tests/automatic-updates.test.ts`, `tests/render-update-settings.test.tsx`.
- [ ] **Step 5:** typecheck, lint, commit `feat(release): Cramsesh packaging and Windows/Linux release`.

### Task 5: About page

**Files:**
- Create: `components/settings/about-section.tsx` exporting `AboutSection({ version = APP_VERSION, homepage = HOMEPAGE }: { version?: string; homepage?: string })` (import the two constants from `update-settings.tsx`).
- Modify: `components/settings/settings-dialog.tsx` — add `{ id: "about", label: "About" }` last in `SECTIONS` and its `active === "about"` branch wrapped in `<SettingsSection title="About" testid="section-about">`.
- Test: `tests/render-about-section.test.tsx` (new).

Content, in order: `CramseshMark` (size-12) + "Cramsesh" (font-title) + `Version {version}`; tagline `AP prep made EZ`; `Built on LearnHarness by Amos Blomqvist` (link); `Licensed under AGPL-3.0` (link `${homepage}/blob/custom/LICENSE`); `Source code` (link `homepage`). External links open in a new tab with `rel="noreferrer"`. Use existing `SettingsRow`/text styles.

- [ ] **Step 1: Failing test:** render `AboutSection({ version: "1.0.0", homepage: "https://github.com/Kevin09sun/cramsesh" })`; assert text `Cramsesh`, `Version 1.0.0`, `AP prep made EZ`, `Built on LearnHarness by Amos Blomqvist`; link hrefs `https://github.com/amosblomqvist/learnharness`, `https://github.com/Kevin09sun/cramsesh/blob/custom/LICENSE`, `https://github.com/Kevin09sun/cramsesh`. Second test: settings dialog nav lists `About` last and clicking it shows `section-about`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** typecheck, lint, commit `feat(brand): About page with credit`.

### Task 6: README, banners, screenshots, docs

**Files:**
- Create: `build/fonts/Nunito[wght].ttf` + `build/fonts/OFL.txt` (from google/fonts `ofl/nunito`, build-time only), `scripts/make-banners.mjs` (resvg with that font file: master mark + `cram`/`sesh` wordmark + tagline; light: ink `#1F3A5F` + bright blue on transparent; dark: cream + sunflower), outputs `docs/assets/cramsesh_banner_{light,dark}.{svg,png}` at 1876×944; new screenshots `docs/assets/teaching-session.png`, `docs/assets/knowledge-graph.png`.
- Delete: `docs/assets/lh_banner_*`.
- Modify: `README.md` (full rewrite), `CONTRIBUTING.md`, `docs/README.md`, `docs/getting-started.md`, `docs/desktop-release.md` (owner repo, no mac, unsigned Windows SmartScreen note), `docs/claude-code.md`, `docs/custom-providers.md`, `docs/architecture.md`, `docs/compaction-accounting.md` user-facing name mentions, `.github/ISSUE_TEMPLATE/bug_report.yml`, `skills/learnharness/SKILL.md` description text only (name/folder stay).

README structure, in order: banner `<picture>`; one-line pitch with the tagline; **What it does** (teach, quiz, knowledge graph); **What Cramsesh adds** (from the current "What's different in this fork" list plus AP stages: released free-response with official scoring, generated free-response, drawn figures, grading of reasoning, direct web search); screenshots; **Download** (Windows and Linux from `https://github.com/Kevin09sun/cramsesh/releases`; Mac coming later; Windows SmartScreen "More info → Run anyway"; former LearnHarness desktop users: quit and uninstall it first); **Run from source**; **Your keys, your data**; **Built on LearnHarness** (credit line + link, thanks to its contributors, what changed lives in "What Cramsesh adds"); **License** (AGPL-3.0, link LICENSE). No links to `learnharness.ai` or the upstream Discord.

Screenshots: start the app with `LH_DATA_DIR` set to a fresh temp directory seeded with a small demo course and chat (hand-written files in the documented data format, generic AP Calculus content), take light-mode shots of a teaching session and the knowledge graph with a headless browser available in the repo's dev dependencies; delete the temp dir afterwards. Never point at `data/`.

- [ ] **Step 1: Failing test** `tests/readme-brand.test.ts`: README contains `AP prep made EZ`, `Built on LearnHarness by Amos Blomqvist`, `https://github.com/amosblomqvist/learnharness`, `https://github.com/Kevin09sun/cramsesh/releases`, `AGPL-3.0`; contains no `learnharness.ai`, no `discord.gg`, no `lh_banner`; every `docs/assets/...` path it references exists.
- [ ] **Step 2:** FAIL. **Step 3:** implement (run `node scripts/make-banners.mjs`; take screenshots). **Step 4:** PASS; open both banner PNGs and both screenshots and check them visually (controller re-checks).
- [ ] **Step 5:** commit `docs(brand): Cramsesh README, banners and docs`.

### Task 7 (controller): final checks, then owner-gated steps

- [ ] Full suite; failing names must equal the Task 0 baseline. `npm run build` succeeds.
- [ ] Rebuild and restart the local server (stop task `LearnHarness` and the port-3000 chain, `npm run build`, `Start-ScheduledTask LearnHarness`); hand the owner a visual check list (light/dark, tab icon, sidebar logo, About page, Appearance without the serif switch).
- [ ] **Only on the owner's explicit go:** merge into `custom`; push; rename the GitHub repo with `gh repo rename cramsesh -R Kevin09sun/learnharness`; `git remote set-url origin https://github.com/Kevin09sun/cramsesh.git`; confirm the old URL redirects. Tagging `v1.0.0` is a separate owner decision.
