# BlotLens

**English** · [简体中文](README.zh-CN.md) · [Open the app](https://blotlens.top/)

Review Western blot screenshot trends with editable, AI-assisted regions of interest (ROIs). Paste a screenshot, locate bands and labels, inspect sampling regions, and compare a locally calculated relative-intensity chart with the original figure.

**AI proposes positions and labels. Original screenshot pixels determine the measurements.** BlotLens is a research prototype for visual trend review. It does not reproduce experimental replicates, generate P values or error bars, establish exposure linearity, or automatically judge agreement with a published chart.

## Use it

Visit **[blotlens.top](https://blotlens.top/)**. Manual measurement and the synthetic example do not require an API key. For AI recognition, enter your own image-capable, OpenAI-compatible Chat Completions provider in **API settings**.

Use the **中文 / English** selector in the header to switch languages. The preference is remembered in this browser. Switching does not reset the image, ROIs or API settings, and does not change measurement values. Protein names, group labels and original model notes remain as entered.

1. Paste, drop or select a PNG/JPEG screenshot (up to 15 MB).
2. Recognize the full image, or select a WB region and recognize only that region. Include the protein and group labels when selecting a region.
3. Review or edit band and background ROIs, loading-control assignments and the control lane. The leftmost lane is the default control; change it when appropriate.
4. Compare the generated chart with the original figure. Inspect unavailable values and sampling notices.
5. Export a chart as PNG/SVG, an ROI overlay, measurements as CSV, or a reproducible analysis JSON file.

**Check connection** requests the provider's model list without sending an image or saving settings. A successful check does not establish image-input support. HTTP 401 and 403 have distinct diagnostic messages.

## Editing and measurement

- Add a missing band or background ROI without regenerating the grid.
- Shift / Ctrl / ⌘ click selects multiple ROIs. Arrow keys move them by 1 pixel; Shift increases the step to 10 pixels. Backspace / Delete removes selected ROIs; Esc cancels selection or drawing.
- Undo and redo the latest 50 workspace edits. Loading another analysis or image starts a new undo history; exported audit history is retained.
- Band ROI sizes stay consistent within each protein row. Positions can be adjusted independently.
- Optional slight overlap within a row permits up to 10% overlap per ROI and retains a visible notice. Shared pixels are counted in each band; substantial or cross-row overlap remains invalid.
- Suggest missing backgrounds, or draw/edit them manually. No image reconstruction or watermark removal is performed.
- Zoom in or out, change preview contrast, and choose chart colors. These display options do not change measurement pixels.

Transparent pixels are composited over white. Grayscale conversion is fixed:

```text
gray = round(0.299 R + 0.587 G + 0.114 B)
signal = 255 − gray
net signal = sum(band signal) − band area × mean(background signal)
normalized intensity = target net signal / same-lane reference net signal
relative intensity = normalized intensity / normalized intensity in the control lane
```

Background subtraction is the default. **Quick trend** uses the uncorrected band signal sum for both reference and control normalization. Existing background ROIs are retained but unused in this mode. Charts and exports identify the selected mode. Background contributes to uncorrected signal, especially for weak bands.

Non-positive signals remain visible for inspection. Invalid targets, reference signals or control values produce unavailable relative values, without clipping to zero or adding a small constant. Near-black pixels are recorded as optional information: black can be a normal band appearance and does not, by itself, establish exposure saturation.

Charts and PNG/SVG exports use the selected interface language. CSV column identifiers remain stable, with localized check messages. Analysis JSON preserves the source image and hash, geometry, pairings, calculation policy, software and algorithm versions, model configuration (without its key), prompt version, model response and edit history. Reloading recalculates locally without a cloud call.

## Run locally

Requires Node.js **22.12 or newer**.

```sh
npm ci
npm run dev
```

Open the loopback address printed by the service (normally `http://127.0.0.1:4317`). For a production build:

```sh
npm run build
npm start
```

The local service binds to `127.0.0.1` and checks request origins. Do not expose its default configuration directly to the internet. The local version supports custom HTTPS endpoints and loopback HTTP model services. Base URLs are API prefixes, such as `https://api.example.com/v1`; BlotLens appends `/chat/completions`.

## Keys and privacy

| Mode | Key handling |
| --- | --- |
| Local | The key remains in the local service's memory until it stops. Browser refresh does not clear that service memory. |
| Hosted, default | The key stays in page memory and is cleared on refresh. Each request carries its own credentials; there is no shared server configuration. |
| Hosted, “Remember” enabled | The user explicitly opts in to saving the provider, model and key in this browser's `localStorage`. Uncheck Remember or clear the key, then Save to delete it. |

Browser storage is **not an encrypted vault**; use Remember only on a personal device. Keys are excluded from analysis exports and are not persisted by the hosted server or written to request logs. Recognition forwards the screenshot and key through the BlotLens server to the selected provider, whose data policy applies. Remembering a key does not save your analysis workspace; export the analysis JSON before refreshing.

The hosted service uses an operator-managed provider allowlist, request limits, response-size limits, timeouts and cancellation. It does not silently change providers or retry recognition. Listing a provider does not imply that every model supports images. A server-side 403 can involve permissions, IP allowlists or regional restrictions, rather than an invalid key.

## Public deployment

The public service runs behind HTTPS with a loopback Node process and Caddy. The release bundle includes the built frontend and bundled Node server:

```sh
npm run package:release
```

See the [Ubuntu deployment guide](deploy/README.md) (Chinese) for installation, provider allowlists, service management and rollback. This guide documents the operator workflow; it does not contain user keys. [Deployment and validation notes](deploy/VALIDATION.md) distinguish automated checks from real-provider validation.

## Development and validation

```sh
npm run check       # unit tests, TypeScript checks and production build
npm run test:e2e    # browser workflows; install Playwright Chromium first
npm run evaluate   # fixture-based evaluation
```

The test suite covers known-pixel measurements, background correction, reference/control pairing, non-positive signals, transparency, out-of-bounds regions, editing, exports, provider isolation, optional key persistence and language switching. Provider mocks make automated recognition tests reproducible. A successful model-list request is not a real screenshot-recognition benchmark.

The supplied example figures are workflow checks, not quantitative ground truth. Claims about generalization, efficiency or accuracy require an independent screenshot set, manual annotations and ImageJ comparisons under matched grayscale/ROI/background settings. No statistical validity is inferred from one displayed blot.

## WB Workbench integration

BlotLens remains an independent project. The WB Workbench can embed a pinned version and transfer a screenshot using the versioned same-origin host protocol. Receiving an image does not automatically invoke an AI service. See the [integration documentation](docs) and [Chinese project guide](README.zh-CN.md) for additional methods and validation material.

## License

[MIT](LICENSE). Source code: [Gaoyuan-0423/blotlens](https://github.com/Gaoyuan-0423/blotlens).
