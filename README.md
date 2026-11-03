# Convertline

Convert videos, music, images and documents in batches. Drop files or whole folders, pick a target per type, press Convert.

Website: [mert.win/convert](https://mert.win/convert/)

## Features

- **Video:** MP4, WebM, MKV, MOV, AVI and GIF with H.264, H.265, AV1 or VP9. Files that already fit the target are only repackaged and finish in seconds.
- **Target size:** set a size in MB and Convertline hits it with two passes.
- **Sound only:** turn any video into MP3, M4A, FLAC, WAV, OGG or Opus.
- **Music:** tags and covers stay where the format supports them, with optional loudness levelling.
- **Images:** PNG, JPG, WebP, AVIF, BMP, TIFF, GIF, ICO and PDF, plus HEIC and SVG as input. Rotation from photos is applied.
- **Documents:** TXT, Markdown, HTML and DOCX to PDF, HTML, text or Markdown. PDF to images or text.
- **Graphics card:** NVIDIA, AMD, Intel and Apple encoders are tested on your machine and used when they work.
- **Safe by design:** originals are never changed. Results appear only when they are complete, so a stopped job leaves nothing behind.
- 12 languages, light and dark mode, optional Acrylic style. Right-click "Convert with Convertline" on Windows.

## Download

| System | File |
| --- | --- |
| Windows (installer) | `Convertline-Setup-<version>.exe` |
| Windows (portable) | `Convertline-<version>-portable.exe` |
| Linux | `.deb`, `.pacman` or `.tar.gz` |
| macOS | `Convertline-<version>-mac-arm64.zip` or `-mac-x64.zip` |

All files are on the [releases page](https://github.com/erqf1/convertline/releases/latest). The Windows installer updates itself.

## Building

Requires Node.js 22.2+ and Python 3.

```bash
npm ci
npm run ffmpeg
npm start
```

Tests run in a hidden window:

```bash
npx electron . --selftest ./test-output
```

## License

Apache License 2.0 for the Convertline source code. Release packages bundle [FFmpeg](https://ffmpeg.org) (GPL build), which keeps its own license. Document conversion uses [pdf.js](https://mozilla.github.io/pdf.js/), [mammoth](https://github.com/mwilliamson/mammoth.js), [marked](https://marked.js.org) and [Turndown](https://github.com/mixmark-io/turndown).
