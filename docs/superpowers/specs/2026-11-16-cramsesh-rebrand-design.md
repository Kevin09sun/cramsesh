# Cramsesh rebrand — design

Status: draft for owner approval (2026-11-16).
Repo: the owner's fork of LearnHarness (`Kevin09sun/learnharness`, branch `custom`).
Recon of everything the name, logo and theme touch: see "Where things live" at the end.

## Intent

The owner is relaunching their fork publicly as **their own product, Cramsesh**. They use it to study for AP exams; the fork has grown well beyond the original (AP prep with released and generated free-response questions, grading of the learner's reasoning, direct web search, drawn figures, light mode, test prep, Windows scripts). Today it still looks and reads like LearnHarness. The goal: someone landing on the repo, the app or an installer sees Cramsesh — its own name, logo, colours and type — while the original project is credited openly and the changes are listed, as the owner wants and as AGPL-3.0 requires.

## Goals

- Every **user-visible** surface says Cramsesh and uses the new logo, colours and font: app chrome, browser tab, page title, settings text, update banner, native file-dialog captions, desktop app name/icons/installers, README.
- A **fully warm theme** in both light and dark mode.
- **Own desktop releases** from the owner's GitHub, with the in-app updater pointing there.
- **Credit and change list**: README and a new in-app About page credit "LearnHarness by Amos Blomqvist" with a link, state the AGPL-3.0 license, and list what Cramsesh adds.
- Existing data and setups keep working with no manual steps.

## Non-goals

- No feature changes. Behaviour of tutors, AP mode, tests, graph etc. is untouched.
- No renaming of hidden technical identifiers (see Constraints).
- No new website, domain, or trademark work. (Owner knowingly keeps the name although an unrelated study app exists at cramsesh.ai.)

## Anti-goals (failure even if it "works")

- Any existing user — including the owner on both computers — opening the app and finding their chats, graph, AP data or settings gone.
- The desktop app offering to "update" to an upstream LearnHarness build.
- Credit to the original disappearing, or the license obligations (keep license, mark changes, source available, AGPL §13) being broken.
- README screenshots leaking the owner's private notes or chats.
- Text that becomes hard to read because of the new colours.

## Decisions (owner's)

- **Name:** Cramsesh. Written "Cramsesh" in prose and titles; the wordmark is lowercase **cram**sesh with "sesh" in bright blue (see mockups).
- **Logo:** "late-night mug, two-colour": a rounded square in bright blue `#3D6FB6`; a sunflower-yellow `#F2B33D` mug with a handle; three cream `#FBF6EA` steam wisps above; a bright-blue tick on the mug. Reference sketch: `.superpowers/brainstorm/691-1794848967/content/logo-mug-v2.html`, option 2 (not committed; geometry below). The final is a polished version of that sketch, same composition and colours.
- **Palette:** cream `#FBF6EA`, sunflower `#F2B33D`, ink blue `#1F3A5F`, bright blue `#3D6FB6`.
- **Theme:** fully warm, not accents-only. Light mode = cream paper with ink-blue text; dark mode = deep ink-blue night (not near-black) with cream text; yellow highlights. Reference: `app-theme.html` option B.
- **Font:** Nunito everywhere in the UI, prose and titles. Maths (KaTeX) and code blocks keep their own fonts.
- **Desktop:** own releases from the owner's GitHub; installers and app named Cramsesh; updater feed points at the owner's repo.
- **No Mac build for 1.0.0.** The release pipeline signs and notarises with the original author's Apple account (secrets `MAC_CSC_LINK`, `APPLE_ID`, …; team `JS6XN22HY6` hardcoded in `desktop:dist`), which the owner can't use. 1.0.0 ships Windows and Linux only; the mac job is disabled (not deleted) so it can return once the owner has signing. README download copy says Mac is coming later and drops the signed/notarised claim.
- **Author metadata:** `package.json` `author` is "Hongyi Sun" with the owner's GitHub no-reply address (`<id>+Kevin09sun@users.noreply.github.com`, id from `gh api users/Kevin09sun`), never the personal email; `contributors` lists Amos Blomqvist as original author.
- **Repo:** rename `Kevin09sun/learnharness` → `Kevin09sun/cramsesh`. The rename is a public action done only on the owner's explicit go at the very end.

## Decisions (mine, approved by the owner in review of the summary)

- **Tagline:** "AP prep made EZ".
- **Version:** restart at **1.0.0**.
- **README:** leads with Cramsesh (new banner, tagline, what it does), then a **"What Cramsesh adds"** list, then usage/download, and ends with **"Built on LearnHarness by Amos Blomqvist"** (link to `https://github.com/amosblomqvist/learnharness`) plus the AGPL-3.0 note. The current "original README follows" block is replaced, not kept below.
- **Settings → About** (new section): logo, "Cramsesh" + version, tagline, the credit line with link, license name with link to the LICENSE/source, link to the owner's repo (this also serves AGPL §13: users of a networked copy are offered the source).
- **Hidden names stay:** `LH_*` env vars, `x-learnharness-*` headers, `application/x-learnharness-source`, the MCP bridge name and `mcp__learnharness__*` tool prefix, the `learnharness` skill folder, `lh:`/`lh-`/`lh.` storage keys, `Symbol.for("lh.*")`, `window.lh`, the `LearnHarnessFileDialog` PowerShell class, the Windows scheduled tasks `LearnHarness` and `LearnHarness Data Sync`, `%LOCALAPPDATA%\LearnHarnessAutostart`, and the private data repo name `learnharness-data`. Only text a person reads changes.
- **Desktop data folder:** the app name (and so the default profile folder) becomes `Cramsesh`; on start, if a `Cramsesh` folder does not exist but a `LearnHarness` one does, the app keeps using the `LearnHarness` folder. Nothing is moved or copied.

## Approaches considered

1. **Surface rebrand + own release pipeline, hidden names kept** — chosen. Changes everything people see and the release/update identity; leaves load-bearing internal identifiers alone so data, scripts, the Electron↔server contract and the Claude Code bridge keep working.
2. **Full rename including internal identifiers** — rejected: ~260 occurrences in ~95 files, many load-bearing (env vars, headers, data paths, scheduled tasks, data repo); each needs a migration, and the payoff is invisible to users.
3. **Accents only (logo + buttons on the old grey UI)** — rejected by the owner: it would still look like LearnHarness.

## Constraints

- **AGPL-3.0-only** stays. Keep `LICENSE` unchanged; `package.json` keeps `"license": "AGPL-3.0-only"`. Credit and change list are visible in README and the app. Amos Blomqvist is not removed as an author (see Author metadata).
- **GitHub fork status:** GitHub reports the repo is not in a fork network today (`fork: false`), so the final step is a plain rename; the README and About page carry the link to the original.
- **Old desktop installs:** the LearnHarness desktop app is not installed on the owner's Windows machine (checked 2026-11-16: no `%APPDATA%\LearnHarness`, no uninstall entry); the owner runs the web server. The new app id means Cramsesh installs beside any old LearnHarness desktop app rather than upgrading it; the README tells former LearnHarness desktop users to quit/uninstall it before first launch (both would share one profile through the folder fallback).
- **Next.js 16 / Tailwind v4:** read `node_modules/next/dist/docs/` before touching metadata/icon routes or fonts (AGENTS.md). Theme tokens live only in `app/globals.css` (no Tailwind config).
- **Readable colours:** body text and UI text meet WCAG AA contrast (4.5:1 normal text, 3:1 large text and UI parts) against their backgrounds in both modes. Where a brand colour fails (e.g. bright blue `#3D6FB6` text on the dark ink background, yellow text on cream) use a lighter/darker shade of the same hue for that use, not a different colour.
- **No private data in public assets:** new screenshots are taken from a fresh, empty data folder (`LH_DATA_DIR` pointed at a temporary directory) with demo content, never from `data/`.
- **Windows setup on a new machine must still work after the repo rename:** `scripts/windows/setup.ps1` derives the data-repo URL by replacing `/learnharness(.git)?$` with `/learnharness-data.git`; it must also map `/cramsesh(.git)?$` to the same `learnharness-data.git`.
- **Upstream-only automation:** `.github/workflows/notify-website.yml` targets the original author's website; remove it.
- Existing tests that assert product/package names, release artifact names or the publish repo are updated to the new values; tests asserting the kept hidden names stay as they are.
- Commit trailer and other repo rules as in prior work; the repo rename and any push happen only on the owner's go.

## What changes, by area

**Brand assets**
- Master logo SVG (replaces `build/icon-flat.svg`). Sketch geometry on a 100×100 grid: square `rx 22` fill `#3D6FB6`; mug body `x28 y42 w38 h36 rx7` fill `#F2B33D`; handle `M66 50h5a8 8 0 0 1 0 16h-5`, stroke `#F2B33D` width 6; steam `M38 36c-4-5 4-8 0-14` repeated at x 48 and 58, stroke `#FBF6EA` width 4–5, round caps; tick `M37 60l7 7l13-13`, stroke `#3D6FB6` width 6, round caps/joins. Polish (proportions, optical balance) is the builder's, keeping this composition.
- Regenerate `build/icon.png`, `build/icon.ico`, `build/icon.icns`, and the macOS layered `build/icon.icon/` from the master.
- In-app mark: replace `components/lh-mark.tsx` usage in the sidebar with the Cramsesh mark (file may be renamed; the sidebar home link keeps working).
- Browser-tab icon (new): Next.js app icon from the master.
- README banners for light and dark (replace `docs/assets/lh_banner_*`): mark + "cram**sesh**" wordmark in Nunito, ink/bright blue on light, cream/yellow on dark, as in the mockups.
- DMG background (`build/background*.png`) re-tinted to the palette if it shows the old greys.

**Theme and type** (`app/globals.css`, `app/layout.tsx`)
- Light tokens start from: background `#FBF6EA`, card/secondary/muted `#F4ECD8`, popover `#FFFCF4`, border/input `#E3D6B8`, foreground `#1F3A5F`, primary `#3D6FB6` (on-primary `#FBF6EA`), highlight/accent from `#F2B33D`.
- Dark tokens start from: background `#14213A`, card/secondary `#1A2A47`, muted/popover `#182640`, border/input `#2B3F63`, foreground `#EDE6D6`, primary `#F2B33D` (on-primary `#1F3A5F`), links in a light shade of bright blue or yellow.
- Muted text, ring, accent, destructive and the graph/visual colours re-derived to fit and meet contrast. Any hard-coded greys elsewhere (graph view, artifacts, cards) are moved onto the tokens or re-tinted so nothing still looks like the old grey UI.
- Fonts: Nunito via `next/font/google` replaces JetBrains Mono (UI), Source Sans 3 (prose) and the bundled CMU Serif titles. Code and maths keep monospace/KaTeX fonts. Remove `public/fonts/cmunbx.ttf` + `OFL.txt` only if nothing else uses them.
- **Owner decision:** the Settings → Appearance "Session names in serif" switch is removed (titles are always Nunito). Saved settings that still carry it load fine and it is ignored. The reading-font picker stays, with Nunito as its default.
- The default mode (currently dark) is unchanged.

**Names in text**
- `app/layout.tsx` metadata: title "Cramsesh", description rewritten for Cramsesh (tagline-led).
- Every user-visible string listed in recon (update banner, ChatGPT/subscription notices, model-menu tooltip, Claude Code status, server error texts shown in the UI, native file-dialog captions, `USER_AGENT` sent to College Board in `src/agent/ap-papers.ts` → `Cramsesh/1.0`; the `learnharness/<v>` UA in `src/agent/models.ts` → `cramsesh/<v>`).
- `README.md`, `CONTRIBUTING.md`, `docs/*.md` user-facing docs, issue templates: say Cramsesh and point at the owner's repo; historical `docs/superpowers/**` specs and plans are left as written.

**Packaging and releases**
- `package.json`: `name` `cramsesh`, `version` `1.0.0`, `description`, `homepage` → owner's repo, `author`/`contributors` as above, `desktopName` `cramsesh.desktop`.
- `electron-builder.yml`: `appId` (e.g. `com.cramsesh.Cramsesh`), `productName` `Cramsesh`, mic usage text, `publish` owner/repo → the owner's GitHub account and `cramsesh`.
- `electron/main.cjs`: product name `Cramsesh` with the data-folder fallback above.
- `.github/workflows/release.yml`, `scripts/verify-release.ts` and their tests: new app/artifact names; mac job disabled and the release verified without mac artifacts.
- Update feed (`LH_UPDATE_FEED`/`LH_HOMEPAGE` derivation) resolves to the owner's repo; release-notes link likewise.

**Credit**
- README sections as decided above; About page as decided above.

**Final, owner-gated steps**
- Rename the GitHub repo to `cramsesh`; update the local `origin` URL; confirm the old URL redirects.
- Publishing a first release (tag `v1.0.0`) is a separate owner decision after the rebrand is merged.

## Left to the builder

- Exact derived shades for muted text, borders, hover/active states, graph colours, focus rings — within the palette and contrast rule.
- Logo polish within the fixed composition.
- How icons are generated (extend `scripts/make-icons.mjs`), and how the About section is laid out within the existing Settings dialog style.
- Wording of the "What Cramsesh adds" list, drawn from the current README fork list and the AP stages.

## Where things live (from recon, 2026-11-16)

- Theme: `app/globals.css` (tokens, `--lh-mark-ring`, `lh-cmu` font-face); fonts in `app/layout.tsx`.
- Logo: `components/lh-mark.tsx` (sidebar `components/sidebar.tsx`), `build/icon-flat.svg`, `build/icon.{png,ico,icns}`, `build/icon.icon/`, `scripts/make-icons.mjs`, `scripts/after-pack.cjs`, `docs/assets/lh_banner_{light,dark}.{svg,png}`. No favicon or manifest today.
- Settings sections: `components/settings/settings-dialog.tsx`; version/update UI `components/settings/update-settings.tsx`; banner `components/update-banner.tsx`.
- Packaging: `package.json`, `electron-builder.yml`, `electron/main.cjs`, `.github/workflows/release.yml`, `.github/workflows/notify-website.yml`, `scripts/verify-release.ts`, `tests/verify-release.test.ts`.
- Windows: `scripts/windows/setup.ps1`, `start-server.cmd`, `sync-data.ps1`.
